-- ===========================================================================
-- 015 — El aviso ya programado no se pisa (primero gana)
-- ===========================================================================
-- Solo cambia UNA línea del WHERE de programar_aviso_siguiente():
--   AND t.aviso_programado_en IS NULL
--
-- Con eso, si V1 ya programó un aviso en A-003, V2 salta a A-004 en vez de
-- pisar el de V1. No hay campo nuevo, ni trigger, ni reserva, ni cambio en
-- llamar_siguiente_turno. Si un operador quiere cambiar su propio aviso,
-- primero lo cancela (RPC cancelar_aviso_siguiente) y luego programa otro.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION programar_aviso_siguiente(
    p_minutos INTEGER,
    p_tramite_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador  UUID;
    v_permiso   INTEGER[];
    v_momento   TIMESTAMPTZ;
    v_abiertos  INTEGER;
    v_cantidad  INTEGER;
    v_turno     turnos%ROWTYPE;
    v_tramite   tramites%ROWTYPE;
    v_turnos    JSONB := '[]'::JSONB;
    v_saltados  INTEGER := 0;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;
    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para programar avisos.'
            USING ERRCODE = '42501';
    END IF;

    v_permiso := opciones_aviso_minutos();
    IF p_minutos IS NULL OR NOT (p_minutos = ANY (v_permiso)) THEN
        RAISE EXCEPTION 'Minutos no validos. Opciones: %.', array_to_string(v_permiso, ', ')
            USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*) INTO v_abiertos
      FROM turnos t
      INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
     WHERE p.estado = 'ABIERTO'
       AND t.estado IN ('CALLED', 'SERVING');

    v_cantidad := GREATEST(1, v_abiertos);
    v_momento  := clock_timestamp() + make_interval(mins => p_minutos);

    FOR v_turno IN
        SELECT t.*
          FROM turnos t
          INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
         WHERE p.estado = 'ABIERTO'
           AND t.estado = 'WAITING'
           -- LA LÍNEA NUEVA: no pisar avisos existentes.
           AND t.aviso_programado_en IS NULL
           AND (p_tramite_id IS NULL OR t.tramite_id = p_tramite_id)
         ORDER BY
            CASE t.prioridad
                WHEN 'URGENTE'    THEN 1
                WHEN 'PREFERENTE' THEN 2
                ELSE 3
            END,
            t.creado_en,
            t.id
         LIMIT v_cantidad
         FOR UPDATE OF t
    LOOP
        UPDATE turnos
           SET aviso_programado_en  = v_momento,
               aviso_programado_por = v_operador
         WHERE id = v_turno.id;

        SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

        PERFORM registrar_historial(
            v_turno.id, v_turno.estado, v_turno.estado, v_operador, NULL,
            format('Aviso programado para dentro de %s minutos.', p_minutos),
            jsonb_build_object('aviso_programado_en', v_momento, 'minutos', p_minutos)
        );

        PERFORM registrar_auditoria(
            v_operador, 'PROGRAMAR_AVISO', 'turnos', v_turno.id::text, 'EXITO',
            jsonb_build_object('minutos', p_minutos, 'codigo', v_turno.codigo)
        );

        v_turnos := v_turnos || jsonb_build_object(
            'turno_id',      v_turno.id,
            'codigo',        v_turno.codigo,
            'folio',         v_turno.folio,
            'clave_tramite', v_tramite.clave
        );
    END LOOP;

    IF v_turnos = '[]'::JSONB THEN
        SELECT COUNT(*) INTO v_saltados
          FROM turnos t
          INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
         WHERE p.estado = 'ABIERTO'
           AND t.estado = 'WAITING'
           AND t.aviso_programado_en IS NOT NULL
           AND (p_tramite_id IS NULL OR t.tramite_id = p_tramite_id);

        RAISE EXCEPTION 'Todos los turnos en espera ya tienen un aviso programado (%). Cancele uno para reprogramarlo.',
            v_saltados
            USING ERRCODE = 'P0004';
    END IF;

    RETURN jsonb_build_object(
        'ok',                  true,
        'minutos',             p_minutos,
        'aviso_programado_en', v_momento,
        'lugares_ocupados',    v_abiertos,
        'total',               jsonb_array_length(v_turnos),
        'turnos',              v_turnos
    );
END;
$$;

COMMIT;
