-- ============================================================================
-- Migración 54 — Quitar prioridad del orden (FIFO puro en visualización)
-- ============================================================================
-- Tras la mig 53 (asignación FIFO), se elimina la prioridad del resto de
-- vistas/funciones para que TODO el sistema sea FIFO por llegada: cola en
-- vivo (TV), estado_ventanillas (pantalla operador) y posicion global.
-- La columna prioridad se mantiene en las tablas (default NORMAL) por
-- compatibilidad, pero ya no se usa en ningún ORDER BY ni se muestra.
-- ============================================================================
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

-- cola_en_vivo: quitar prioridad del posicion/posicion_global
CREATE OR REPLACE FUNCTION public.cola_en_vivo(p_limite integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo UUID;
    v_total   INTEGER;
    v_filas   JSONB;
BEGIN
    IF NOT (public.fn_puede_operar_turnos() OR public.fn_es_recepcion()) THEN
        RAISE EXCEPTION 'No tiene permiso para ver la cola en vivo.'
            USING ERRCODE = '42501';
    END IF;

    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object(
            'ok',        true,
            'periodo',   NULL,
            'total',     0,
            'filas',     '[]'::jsonb
        );
    END IF;

    SELECT count(*) INTO v_total
      FROM turnos
     WHERE estado IN ('WAITING','ASIGNED','CALLED')
       AND periodo_operativo_id = v_periodo;

    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_filas
      FROM (
        SELECT jsonb_build_object(
            'turno_id',            t.id,
            'codigo_turno',        t.codigo,
            'folio',               t.folio,
            'clave_tramite',       tr.clave,
            'denominacion_tramite', tr.denominacion,
            'prioridad',           t.prioridad,
            'estado',               t.estado,
            'posicion_llegada',    row_number() OVER (ORDER BY t.creado_en, t.id),
            'posicion_global',     row_number() OVER (ORDER BY t.creado_en, t.id),
            'creado_en',           t.creado_en,
            'modulo_codigo',       m.codigo
        ) AS fila
        FROM turnos t
        JOIN tramites tr ON tr.id = t.tramite_id
        LEFT JOIN modulos m ON m.id = t.modulo_id
        WHERE t.estado IN ('WAITING','ASIGNED','CALLED')
          AND t.periodo_operativo_id = v_periodo
        ORDER BY t.creado_en, t.id
        LIMIT greatest(coalesce(p_limite, 10), 0)
      ) s;

    RETURN jsonb_build_object(
        'ok',      true,
        'periodo', v_periodo,
        'total',   v_total,
        'filas',   v_filas
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cola_en_vivo(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.estado_ventanillas() TO authenticated;

NOTIFY pgrst, 'reload schema';
