-- ============================================================================
-- Migración 55 — Asignar usuario a ventanilla
-- ============================================================================
-- 1. RPC `asignar_usuario_ventanilla(usuario_id, modulo_id)` que asigna o
--    desasigna un usuario a una ventanilla. Solo ADMINISTRADOR puede hacerlo.
-- 2. RPC `listar_usuarios_para_asignacion()` que devuelve la lista de usuarios
--    activos con rol OPERADOR o ADMINISTRADOR, con su nombre completo y
--    ventanilla asignada actual.
-- ============================================================================

-- [1] asignar_usuario_ventanilla ---------------------------------------------
CREATE OR REPLACE FUNCTION public.asignar_usuario_ventanilla(
    p_usuario_id uuid,
    p_modulo_id  uuid  -- NULL para desasignar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_rol      text;
    v_usuario  uuid;
    v_modulo   uuid;
BEGIN
    v_operador := public.fn_usuario_actual();

    -- Solo ADMINISTRADOR puede asignar usuarios
    SELECT r.clave INTO v_rol
      FROM public.roles r
      JOIN public.usuarios u ON u.rol_id = r.id
     WHERE u.id = v_operador;

    IF v_rol IS DISTINCT FROM 'ADMINISTRADOR' THEN
        RAISE EXCEPTION 'Solo un administrador puede asignar usuarios a ventanillas.'
            USING ERRCODE = '42501';
    END IF;

    -- Validar que el usuario existe
    SELECT id INTO v_usuario FROM public.usuarios WHERE id = p_usuario_id;
    IF v_usuario IS NULL THEN
        RAISE EXCEPTION 'El usuario no existe.' USING ERRCODE = 'P0001';
    END IF;

    -- Validar que el modulo existe (si no es NULL)
    IF p_modulo_id IS NOT NULL THEN
        SELECT id INTO v_modulo FROM public.modulos WHERE id = p_modulo_id;
        IF v_modulo IS NULL THEN
            RAISE EXCEPTION 'La ventanilla no existe.' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    -- Actualizar la asignación
    UPDATE public.usuarios
       SET modulo_id = p_modulo_id, actualizado_en = now()
     WHERE id = p_usuario_id;

    -- Registrar en auditoria
    INSERT INTO public.auditoria (accion, entidad, entidad_id, metadata)
    VALUES (
        'ASIGNAR_USUARIO_VENTANILLA',
        'usuarios',
        p_usuario_id,
        jsonb_build_object(
            'usuario_id', p_usuario_id,
            'modulo_id', p_modulo_id,
            'realizado_por', v_operador
        )
    );

    RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.asignar_usuario_ventanilla IS
    'Asigna o desasigna un usuario a una ventanilla. Solo ADMINISTRADOR.';

REVOKE ALL ON FUNCTION public.asignar_usuario_ventanilla(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.asignar_usuario_ventanilla(uuid, uuid) TO authenticated;


-- [2] listar_usuarios_para_asignacion ----------------------------------------
CREATE OR REPLACE FUNCTION public.listar_usuarios_para_asignacion()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_rol      text;
    v_result   jsonb;
BEGIN
    v_operador := public.fn_usuario_actual();

    -- Solo ADMINISTRADOR puede listar
    SELECT r.clave INTO v_rol
      FROM public.roles r
      JOIN public.usuarios u ON u.rol_id = r.id
     WHERE u.id = v_operador;

    IF v_rol IS DISTINCT FROM 'ADMINISTRADOR' THEN
        RAISE EXCEPTION 'Solo un administrador puede ver esta información.'
            USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_result
      FROM (
        SELECT jsonb_build_object(
            'id',              u.id,
            'nombres',         u.nombres,
            'apellido_paterno', COALESCE(a_pat.apellido, ''),
            'apellido_materno', COALESCE(a_mat.apellido, ''),
            'email',           u.email,
            'numero_empleado', u.numero_empleado,
            'rol',             r.clave,
            'modulo_id',       u.modulo_id,
            'modulo_codigo',   m.codigo,
            'modulo_denominacion', m.denominacion,
            'activo',          u.activo
        ) AS fila
        FROM public.usuarios u
        JOIN public.roles r ON r.id = u.rol_id
        LEFT JOIN public.apellidos a_pat ON a_pat.id = u.apellido_paterno_id
        LEFT JOIN public.apellidos a_mat ON a_mat.id = u.apellido_materno_id
        LEFT JOIN public.modulos m ON m.id = u.modulo_id
        WHERE u.activo = true
          AND r.clave IN ('OPERADOR', 'ADMINISTRADOR', 'AGENTE')
        ORDER BY r.clave, u.nombres
      ) s;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.listar_usuarios_para_asignacion IS
    'Lista usuarios activos con rol OPERADOR/ADMINISTRADOR/AGENTE para asignación a ventanillas.';

REVOKE ALL ON FUNCTION public.listar_usuarios_para_asignacion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_usuarios_para_asignacion() TO authenticated;
