-- ============================================================================
-- SITUR — MIGRACIÓN 036: EL QR DE UN TURNO CONCRETO DE LA COLA
-- ============================================================================
--
-- PROBLEMA
--
-- En la pantalla de turnos en vivo, recepción puede elegir un turno de la
-- lista para que la pantalla muestre su código. Para eso hace falta el
-- `token_publico` de ESE turno.
--
-- Pero `turnos` solo es legible por ADMINISTRADOR (política `p_admin_turnos`)
-- y por RECEPCIÓN (`p_recepcion_turnos_select`). El rol AGENTE —que también
-- abre esta pantalla— no tiene ninguna política de SELECT sobre la tabla, y
-- la vista `vista_cola_espera` funciona para él solo porque una vista normal
-- se ejecuta con los privilegios de su dueño (RLS de la tabla no la frena).
--
-- La lectura directa que hace el cliente (`supabase.from('turnos')`) devuelve
-- cero filas para un AGENTE, así que el QR nunca llegaría a pintarse.
--
-- SOLUCIÓN
--
-- Una RPC `SECURITY DEFINER` que devuelve el token de UN turno, comprobando
-- que quien llama puede operar turnos. Es la puerta única para el token: no
-- se expone la columna ni se listan tokens a ciegas.
--
-- De paso, RENUEVA el token si ya había caducado. Un turno que lleva mucho
-- en espera tiene el token vencido (la vigencia en espera son 24 h), y un QR
-- caducado no sirve de nada: el ciudadano recibiría «Token expirado» al
-- escanearlo. Renovar solo cuando ya venció deja el resto intacto.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.token_turno_para_qr(p_turno_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno turnos%ROWTYPE;
BEGIN
    IF p_turno_id IS NULL THEN
        RAISE EXCEPTION 'Falta el turno.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT (public.fn_puede_operar_turnos() OR public.fn_es_recepcion()) THEN
        RAISE EXCEPTION 'No tiene permiso para ver el codigo QR de un turno.'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno
      FROM turnos
     WHERE id = p_turno_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.'
            USING ERRCODE = 'P0002';
    END IF;

    -- Token caducado (turno que lleva mucho en espera): se renueva para que
    -- el QR que se muestra sirva. El resto de los campos no se tocan.
    IF v_turno.token_expira_en IS NOT NULL AND v_turno.token_expira_en <= now() THEN
        UPDATE turnos
           SET token_expira_en = calcular_expiracion_token(v_turno.estado)
         WHERE id = v_turno.id
        RETURNING * INTO v_turno;
    END IF;

    RETURN jsonb_build_object(
        'ok',           true,
        'turno_id',     v_turno.id,
        'codigo_turno', v_turno.codigo,
        'folio',        v_turno.folio,
        'estado',       v_turno.estado,
        'prioridad',    v_turno.prioridad,
        'token_publico', v_turno.token_publico
    );
END;
$$;

COMMENT ON FUNCTION public.token_turno_para_qr(uuid) IS
    'Token publico de un turno concreto, para pintar su QR. Solo para quien puede operar turnos. Renueva el token si ya habia caducado (mig 36).';

NOTIFY pgrst, 'reload schema';

COMMIT;
