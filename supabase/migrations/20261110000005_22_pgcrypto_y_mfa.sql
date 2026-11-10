-- ===========================================================================
-- 022 — pgcrypto en Supabase y el MFA que no se guardaba
-- ===========================================================================
--
-- PROBLEMA 1 · `gen_random_bytes` no existe
-- En Supabase las extensiones viven en el esquema `extensions`, no en
-- `public`. Las RPC se declaran con `SET search_path = public, pg_temp`, así
-- que dentro de ellas `gen_random_bytes(32)` no se encuentra y `generar_turno`
-- falla en producción con:
--
--   function gen_random_bytes(integer) does not exist
--
-- En local no pasaba porque `pgcrypto` se instala en `public`. La solución no
-- es mover la extensión (Supabase desaconseja mover las suyas): es que las
-- funciones que la usan miren también en `extensions`.
--
-- Se recorre `pg_proc` en vez de escribir los nombres a mano para que no se
-- quede ninguna fuera cuando se añada otra RPC que genere tokens.
--
-- PROBLEMA 2 · el MFA se inscribía y no se apuntaba
-- `InscripcionMFA` confirma el factor contra Supabase Auth, pero el permiso
-- para operar lo decide `usuarios.mfa_habilitado`, y **nadie lo escribía**:
-- el operador veía «MFA configurado. Ya puede operar» y, acto seguido, la
-- consola le seguía pidiendo configurarlo. La RPC de abajo cierra ese círculo,
-- y no deja marcarlo sin un factor verificado de verdad.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Las funciones que generan tokens tienen que ver `extensions`
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS firma
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosrc LIKE '%gen_random_bytes%'
    LOOP
        EXECUTE format(
            'ALTER FUNCTION %s SET search_path = public, extensions, pg_temp',
            r.firma
        );
        RAISE NOTICE 'search_path ajustado: %', r.firma;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. La RPC que apunta el MFA en la ficha del operador
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marcar_mfa_habilitado()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_usuario UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT id INTO v_usuario
      FROM usuarios
     WHERE auth_uid = v_uid
       AND activo;

    IF v_usuario IS NULL THEN
        RAISE EXCEPTION 'La cuenta no tiene ficha de operador activa.'
            USING ERRCODE = '28000';
    END IF;

    /*
     * No se marca por pedirlo: tiene que haber un factor TOTP verificado en
     * `auth.mfa_factors`. En el PostgreSQL del arnés local esa tabla no
     * existe (el MFA lo simula el arnés), así que la comprobación solo se
     * aplica cuando existe.
     */
    IF to_regclass('auth.mfa_factors') IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
              FROM auth.mfa_factors f
             WHERE f.user_id = v_uid
               AND f.status = 'verified'
        ) THEN
            RAISE EXCEPTION 'No hay un segundo factor verificado para esta cuenta (RF-026).'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE usuarios
       SET mfa_habilitado = true,
           actualizado_en = now()
     WHERE id = v_usuario
       AND mfa_habilitado = false;

    PERFORM registrar_auditoria(
        v_usuario, 'MFA_HABILITADO', 'usuarios', v_usuario::text, 'EXITO', NULL
    );

    RETURN jsonb_build_object('ok', true, 'mfa_habilitado', true);
END;
$$;

COMMENT ON FUNCTION marcar_mfa_habilitado() IS
    'RF-026: marca la ficha del operador autenticado como MFA configurado, solo si tiene un factor verificado.';

REVOKE ALL ON FUNCTION marcar_mfa_habilitado() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marcar_mfa_habilitado() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
