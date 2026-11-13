-- ===========================================================================
-- 042 — Ampliar estado_ventanillas(): información completa en turnos_asignados
-- ===========================================================================
--
-- Se reabre `estado_ventanillas()` para que cada turno asignado devuelva
-- todos los campos útiles para el modal de opciones del operador:
--
--   - turno_id, turno_codigo, turno_estado (ya existían)
--   - turno_denominacion_tramite (ya existía)
--   - turno_clave_tramite (nuevo): código del trámite (A, B, C, etc.)
--   - turno_folio (nuevo): número consecutivo dentro del periodo+trámite
--   - turno_prioridad (nuevo): NORMAL, PREFERENTE, URGENTE
--   - turno_creado_en (nuevo): cuándo se emitió el turno
--   - turno_llamado_en (nuevo): cuándo se llamó por primera vez
--   - turno_inicio_atencion (nuevo): cuándo inició la atención
--   - turno_modulo_codigo (nuevo): código de la ventanilla asignada
--   - turno_modulo_denominacion (nuevo): denominación de la ventanilla
--   - minutos_en_ventanilla (ya existía)
--   - operador_nombres (ya existía)
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.estado_ventanillas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_periodo  uuid;
    v_cola     jsonb;
    v_vent     jsonb;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'periodo_id', NULL, 'cola', '[]'::jsonb, 'ventanillas', '[]'::jsonb);
    END IF;

    -- Cola global: WAITING
    SELECT COALESCE(jsonb_agg(row_to_json(t))::jsonb, '[]'::jsonb) INTO v_cola
    FROM (
        SELECT t.id AS turno_id, t.codigo AS codigo_turno,
               tr.prefijo AS clave_tramite, tr.denominacion AS denominacion_tramite,
               row_number() OVER (ORDER BY
                   CASE t.prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
                   t.creado_en, t.id
               ) AS posicion
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        WHERE t.periodo_operativo_id = v_periodo
          AND t.estado = 'WAITING'
    ) t;

    -- Ventanillas con array de turnos asignados (ASIGNED, CALLED, SERVING).
    SELECT COALESCE(jsonb_agg(row_to_json(v))::jsonb, '[]'::jsonb) INTO v_vent
    FROM (
        SELECT
            m.id AS modulo_id,
            m.codigo,
            m.denominacion,
            m.estado AS estado_ventanilla,
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM public.turnos t2
                    WHERE t2.modulo_id = m.id AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                ) THEN 'ATENDIENDO'
                ELSE 'DISPONIBLE'
            END AS estado_con_turno,
            -- Array de turnos asignados (hasta 3) — con información completa
            COALESCE((
                SELECT jsonb_agg(row_to_json(tt))
                FROM (
                    SELECT
                        t.id AS turno_id,
                        t.codigo AS turno_codigo,
                        t.estado AS turno_estado,
                        tr.prefijo AS turno_clave_tramite,
                        tr.denominacion AS turno_denominacion_tramite,
                        t.folio AS turno_folio,
                        t.prioridad AS turno_prioridad,
                        t.creado_en AS turno_creado_en,
                        t.llamado_en AS turno_llamado_en,
                        t.inicio_atencion AS turno_inicio_atencion,
                        m.codigo AS turno_modulo_codigo,
                        m.denominacion AS turno_modulo_denominacion,
                        EXTRACT(EPOCH FROM (now() - t.llamado_en)) / 60 AS minutos_en_ventanilla,
                        u.nombres || ' ' || COALESCE(a_pat.apellido, '') || ' ' || COALESCE(a_mat.apellido, '') AS operador_nombres
                    FROM public.turnos t
                    JOIN public.tramites tr ON tr.id = t.tramite_id
                    LEFT JOIN public.usuarios u ON u.id = t.atendido_por
                    LEFT JOIN public.apellidos a_pat ON a_pat.id = u.apellido_paterno_id
                    LEFT JOIN public.apellidos a_mat ON a_mat.id = u.apellido_materno_id
                    WHERE t.modulo_id = m.id
                      AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                    ORDER BY t.creado_en
                    LIMIT 3
                ) tt
            ), '[]'::jsonb) AS turnos_asignados,
            (
                SELECT COUNT(*)
                FROM public.turnos t2
                WHERE t2.modulo_id = m.id
                  AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
            ) AS turno_count,
            (m.id IS NOT DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador)) AS es_mia,
            CASE
                WHEN NOT EXISTS (
                    SELECT 1 FROM public.turnos t2
                    WHERE t2.modulo_id = m.id AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                ) AND m.estado = 'ACTIVO' THEN true
                ELSE false
            END AS disponible
        FROM public.modulos m
        WHERE m.activo
        ORDER BY m.codigo
    ) v;

    RETURN jsonb_build_object(
        'ok', true,
        'periodo_id', v_periodo,
        'cola', v_cola,
        'ventanillas', v_vent
    );
END;
$$;

COMMENT ON FUNCTION public.estado_ventanillas() IS
  'La cola global y el estado de cada ventanilla con array de turnos asignados — info completa (mig 42).';

REVOKE ALL ON FUNCTION public.estado_ventanillas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.estado_ventanillas() FROM anon;
GRANT EXECUTE ON FUNCTION public.estado_ventanillas() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
