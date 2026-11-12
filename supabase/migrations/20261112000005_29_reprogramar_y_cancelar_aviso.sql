-- ===========================================================================
-- 029 — El aviso se puede reprogramar y cancelar desde la consola
-- ===========================================================================
--
-- PROBLEMA
--
-- La migración 015 estableció que el aviso ya programado no se pisa: si un
-- operador programó un aviso en un turno, el siguiente salta al turno
-- siguiente en vez de sobrescribirlo. La regla es buena —son dos ventanillas
-- distintas y el aviso de una no es del otro— pero dejó un agujero:
--
--   · Si el ÚNICO turno en espera ya tiene aviso, la función no encuentra
--     ninguno donde programar y lanza el error «Todos los turnos en espera
--     ya tienen un aviso programado. Cancele uno para reprogramarlo».
--   · Ese «cancele» no se podía hacer: no había ninguna forma de cancelar
--     un aviso desde la consola. El operador se quedaba atrapado, con el
--     botón de «Preparar al siguiente» dando error y sin salida.
--
-- Consecuencia real: el aviso se programaba una vez y no se podía volver a
-- tocar. Ni cambiar los minutos, ni cancelarlo, ni reprogramarlo.
--
-- SOLUCIÓN
--
-- Se distingue entre el aviso de OTRO operador y el propio:
--
--   · El aviso de otro operador NO se toca. Se salta, como hasta ahora.
--   · El aviso del propio operador SE REPROGRAMA: se actualiza la hora y
--     los minutos. Es lo que el operador quiere cuando pulsa «15 min» y
--     antes había puesto «5 min»: cambiar de idea, no empezar de cero.
--
-- Y se añade la cancelación, que la base ya tenía (cancelar_aviso_siguiente)
-- pero la consola no exponía.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) La función de programar, ahora con reprogramación.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS programar_aviso_siguiente(INTEGER, UUID);

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
    v_operador    UUID;
    v_permiso     INTEGER[];
    v_momento     TIMESTAMPTZ;
    v_abiertos    INTEGER;
    v_cantidad    INTEGER;
    v_turno       turnos%ROWTYPE;
    v_tramite     tramites%ROWTYPE;
    v_turnos      JSONB := '[]'::JSONB;
    v_saltados    INTEGER := 0;
    v_reprogramados INTEGER := 0;
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
           AND (p_tramite_id IS NULL OR t.tramite_id = p_tramite_id)
         ORDER BY
            CASE t.prioridad
                WHEN 'URGENTE'    THEN 1
                WHEN 'PREFERENTE' THEN 2
                ELSE 3
            END,
            t.creado_en,
            t.id
         FOR UPDATE
    LOOP
        EXIT WHEN jsonb_array_length(v_turnos) >= v_cantidad;

        -- El aviso de OTRO operador no se toca: se salta a otro turno.
        IF v_turno.aviso_programado_en IS NOT NULL
           AND v_turno.aviso_programado_por IS DISTINCT FROM v_operador THEN
            v_saltados := v_saltados + 1;
            CONTINUE;
        END IF;

        -- El aviso propio se reprograma: el operador está cambiando los
        -- minutos, no repartiendo avisos entre ventanillas.
        IF v_turno.aviso_programado_en IS NOT NULL THEN
            v_reprogramados := v_reprogramados + 1;
        END IF;

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
        -- Ya no se da por hecho que se puede cancelar: la consola lo hace.
        SELECT COUNT(*) INTO v_saltados
          FROM turnos t
          INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
         WHERE p.estado = 'ABIERTO'
           AND t.estado = 'WAITING'
           AND t.aviso_programado_en IS NOT NULL
           AND (p_tramite_id IS NULL OR t.tramite_id = p_tramite_id);

        RAISE EXCEPTION 'Los turnos en espera ya tienen un aviso programado de otra ventanilla (%). Use «Cancelar aviso» para quitarlo.', v_saltados
            USING ERRCODE = 'P0004';
    END IF;

    RETURN jsonb_build_object(
        'ok',                  true,
        'minutos',             p_minutos,
        'aviso_programado_en', v_momento,
        'lugares_ocupados',    v_abiertos,
        'total',               jsonb_array_length(v_turnos),
        'reprogramados',        v_reprogramados,
        'saltados',            v_saltados,
        'turnos',              v_turnos
    );
END;
$$;

COMMENT ON FUNCTION programar_aviso_siguiente(INTEGER, UUID) IS
    'RF-028: programa el aviso de los siguientes turnos de la cola. El aviso de otro operador no se pisa; el propio se reprograma (mig 29).';

NOTIFY pgrst, 'reload schema';

COMMIT;
