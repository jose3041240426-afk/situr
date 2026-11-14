-- ===========================================================================
-- 043 — Transferir turno entre ventanillas
-- ===========================================================================
--
-- Permite transferir un turno ASIGNED de una ventanilla a otra que tenga
-- menos de 3 turnos asignados. Solo se puede transferir un turno en estado
-- ASIGNED (no llamado ni en atención).
--
-- La ventanilla destino debe:
--   1. Estar activa (estado = 'ACTIVO')
--   2. Tener menos de 3 turnos en estados ASIGNED/CALLED/SERVING
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.transferir_turno_ventanilla(
    p_turno_id uuid,
    p_destino_modulo_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_turno_id uuid;
    v_turno_estado text;
    v_origen_modulo_id uuid;
    v_periodo uuid;
    v_destino_count integer;
    v_codigo text;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    -- Solo OPERADOR o ADMINISTRADOR pueden transferir
    IF NOT EXISTS (
        SELECT 1 FROM public.usuarios u
        JOIN public.roles r ON r.id = u.rol_id
        WHERE u.id = v_operador AND r.clave IN ('OPERADOR', 'ADMINISTRADOR')
    ) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No tienes permiso para transferir turnos.');
    END IF;

    -- Obtener periodo abierto
    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No hay periodo operativo abierto.');
    END IF;

    -- Verificar que el turno existe y pertenece al periodo
    SELECT t.id, t.estado, t.modulo_id, t.codigo
    INTO v_turno_id, v_turno_estado, v_origen_modulo_id, v_codigo
    FROM public.turnos t
    WHERE t.id = p_turno_id AND t.periodo_operativo_id = v_periodo;

    IF v_turno_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Turno no encontrado.');
    END IF;

    -- Solo se puede transferir un turno ASIGNED
    IF v_turno_estado != 'ASIGNED' THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Solo se pueden transferir turnos asignados (no llamados ni en atención).');
    END IF;

    -- No se puede transferir a la misma ventanilla
    IF v_origen_modulo_id = p_destino_modulo_id THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'El turno ya está en esa ventanilla.');
    END IF;

    -- Verificar que la ventanilla destino está activa
    IF NOT EXISTS (
        SELECT 1 FROM public.modulos m
        WHERE m.id = p_destino_modulo_id AND m.activo = true AND m.estado = 'ACTIVO'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino no está disponible.');
    END IF;

    -- Verificar que la ventanilla destino tiene menos de 3 turnos
    SELECT COUNT(*) INTO v_destino_count
    FROM public.turnos t
    WHERE t.modulo_id = p_destino_modulo_id
      AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING');

    IF v_destino_count >= 3 THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino ya tiene 3 turnos asignados.');
    END IF;

    -- Transferir el turno
    UPDATE public.turnos
    SET modulo_id = p_destino_modulo_id
    WHERE id = v_turno_id;

    -- Registrar en auditoria
    INSERT INTO public.auditoria (
        usuario_id,
        accion,
        entidad,
        entidad_id,
        detalles
    ) VALUES (
        v_operador,
        'TRANSFERIR',
        'turno',
        v_turno_id,
        jsonb_build_object(
            'codigo', v_codigo,
            'origen_modulo_id', v_origen_modulo_id,
            'destino_modulo_id', p_destino_modulo_id
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'servido', true,
        'turno_id', v_turno_id,
        'codigo_turno', v_codigo,
        'destino_modulo_id', p_destino_modulo_id
    );
END;
$$;

COMMENT ON FUNCTION public.transferir_turno_ventanilla(uuid, uuid) IS
  'Transfiere un turno ASIGNED a otra ventanilla con menos de 3 turnos (mig 43).';

REVOKE ALL ON FUNCTION public.transferir_turno_ventanilla(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transferir_turno_ventanilla(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.transferir_turno_ventanilla(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
