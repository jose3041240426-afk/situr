-- ===========================================================================
-- 059 — Añadir turno_id a transferencias_pendientes y push al aceptar
-- ===========================================================================
--
-- PROBLEMA: Al aceptar una transferencia en el panel de la campana, no se
-- enviaba la notificación push al ciudadano porque no se tenía el turno_id.
--
-- SOLUCIÓN:
--   1. estado_ventanillas(): añadir tu.id AS turno_id en transferencias_pendientes.
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

    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'periodo_id', NULL, 'cola', '[]'::jsonb, 'ventanillas', '[]'::jsonb);
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(t))::jsonb, '[]'::jsonb) INTO v_cola
    FROM (
        SELECT t.id AS turno_id, t.codigo AS codigo_turno,
               tr.prefijo AS clave_tramite, tr.denominacion AS denominacion_tramite,
               t.estado AS estado,
               row_number() OVER (ORDER BY t.creado_en, t.id) AS posicion,
               row_number() OVER (ORDER BY t.creado_en, t.id) AS posicion_llegada,
               t.creado_en,
               m.codigo AS modulo_codigo
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        LEFT JOIN public.modulos m ON m.id = t.modulo_id
        WHERE t.periodo_operativo_id = v_periodo
          AND t.estado = 'WAITING'
    ) t;

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
            COALESCE((
                SELECT jsonb_agg(row_to_json(tt))
                FROM (
                    SELECT
                        t.id AS turno_id,
                        t.codigo AS turno_codigo,
                        t.estado AS turno_estado,
                        tr.denominacion AS turno_denominacion_tramite,
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
            END AS disponible,
            -- transferencias_pendientes: con turno_id (mig 59)
            COALESCE((
                SELECT jsonb_agg(row_to_json(st))
                FROM (
                    SELECT st.id AS solicitud_id,
                           tu.id AS turno_id,
                           tu.codigo AS turno_codigo,
                           mo.codigo AS origen_codigo,
                           st.creado_en
                    FROM public.solicitudes_transferencia st
                    JOIN public.turnos tu ON tu.id = st.turno_id
                    JOIN public.modulos mo ON mo.id = st.origen_modulo_id
                    WHERE st.destino_modulo_id = m.id
                      AND st.estado = 'PENDIENTE'
                    ORDER BY st.creado_en
                ) st
            ), '[]'::jsonb) AS transferencias_pendientes
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
    'Mig 59: añade turno_id a transferencias_pendientes para push al aceptar.';

GRANT EXECUTE ON FUNCTION public.estado_ventanillas() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
