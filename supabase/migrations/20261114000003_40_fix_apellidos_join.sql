-- ===========================================================================
-- 040 — Fix: estado_ventanillas() usa u.apellidos que no existe
-- ===========================================================================
--
-- La tabla `usuarios` no tiene columna `apellidos`. Los apellidos viven en
-- la tabla `apellidos` enlazados por `apellido_paterno_id` y
-- `apellido_materno_id`.
--
-- Se reabre `estado_ventanillas()` con los JOINs correctos, igual que
-- las demás funciones del sistema.
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

    -- Ventanillas con turno asignado (ASIGNED, CALLED, SERVING).
    SELECT COALESCE(jsonb_agg(row_to_json(v))::jsonb, '[]'::jsonb) INTO v_vent
    FROM (
        SELECT
            m.id AS modulo_id,
            m.codigo,
            m.denominacion,
            m.estado AS estado_ventanilla,
            CASE
                WHEN t.id IS NOT NULL THEN
                    CASE
                        WHEN t.estado IN ('ASIGNED', 'CALLED', 'SERVING') THEN 'ATENDIENDO'
                        ELSE 'DISPONIBLE'
                    END
                ELSE 'SIN_DISPONIBILIDAD'
            END AS estado_con_turno,
            t.id AS turno_id,
            t.codigo AS turno_codigo,
            t.estado AS turno_estado,
            tr.denominacion AS turno_denominacion_tramite,
            EXTRACT(EPOCH FROM (now() - t.llamado_en)) / 60 AS minutos_en_ventanilla,
            u.nombres || ' ' || COALESCE(a_pat.apellido, '') || ' ' || COALESCE(a_mat.apellido, '') AS operador_nombres,
            (m.id IS NOT DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador)) AS es_mia,
            CASE
                WHEN t.id IS NULL AND m.estado = 'ACTIVO' THEN true
                ELSE false
            END AS disponible
        FROM public.modulos m
        LEFT JOIN public.turnos t ON t.modulo_id = m.id
            AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
        LEFT JOIN public.tramites tr ON tr.id = t.tramite_id
        LEFT JOIN public.usuarios u ON u.id = t.atendido_por
        LEFT JOIN public.apellidos a_pat ON a_pat.id = u.apellido_paterno_id
        LEFT JOIN public.apellidos a_mat ON a_mat.id = u.apellido_materno_id
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

-- [2] Notificar schema reload ------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;
