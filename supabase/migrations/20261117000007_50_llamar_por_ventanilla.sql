-- ============================================================================
-- Migración 50 — llamar_turno_asignado: propiedad por ventanilla (no por atendido_por)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.llamar_turno_asignado(p_turno_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_turno    public.turnos%ROWTYPE;
    v_modulo   public.modulos%ROWTYPE;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT public.fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede llamar turnos.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno FROM public.turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.estado <> 'ASIGNED' THEN
        RAISE EXCEPTION 'El turno % no está asignado (estado: %).', v_turno.codigo, v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    -- Propiedad por ventanilla: cualquier operador asignado a esa ventanilla
    -- puede llamar el turno, no solo quien lo solicitó.
    IF v_turno.modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RAISE EXCEPTION 'No puede llamar un turno de otra ventanilla.' USING ERRCODE = '42501';
    END IF;

    IF NOT fn_transicion_valida(v_turno.estado, 'CALLED') THEN
        RAISE EXCEPTION 'Transicion % -> CALLED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.turnos
       SET estado = 'CALLED',
           llamado_en = now(),
           atendido_por = v_operador,
           token_expira_en = calcular_expiracion_token('CALLED')
     WHERE id = v_turno.id;

    SELECT * INTO v_modulo FROM public.modulos WHERE id = v_turno.modulo_id;

    INSERT INTO public.historial_turnos
        (turno_id, estado_anterior, estado_nuevo, usuario_id, modulo_id, motivo, metadata)
    VALUES (
        v_turno.id, 'ASIGNED', 'CALLED', v_operador, v_turno.modulo_id,
        'Turno llamado',
        jsonb_build_object('codigo', v_turno.codigo, 'modulo', v_modulo.codigo)
    );

    PERFORM public.registrar_auditoria(
        v_operador, 'LLAMAR_TURNO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo, 'modulo', v_modulo.codigo)
    );

    PERFORM pg_notify(
        'turnos_cambios',
        jsonb_build_object(
            'tipo', 'LLAMADO',
            'turno_id', v_turno.id::text,
            'codigo', v_turno.codigo,
            'modulo_id', v_turno.modulo_id::text,
            'modulo_codigo', v_modulo.codigo
        )::text
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo', v_turno.codigo,
        'modulo_codigo', v_modulo.codigo
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.llamar_turno_asignado(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
