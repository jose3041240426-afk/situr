-- ============================================================================
-- Migración 47 — cola_en_vivo vuelve a incluir ASIGNED (TV/recepción)
-- ============================================================================
-- La cola del agente (estado_ventanillas) se queda en WAITING, pero la
-- pantalla de turnos en vivo / recepción muestra todos los turnos (WAITING
-- y ASIGNED) con su ventanilla asignada o "ventanilla por asignar".
-- ============================================================================
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
     WHERE estado IN ('WAITING','ASIGNED')
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
            'posicion_global',     row_number() OVER (
                                    ORDER BY CASE t.prioridad
                                                WHEN 'URGENTE' THEN 1
                                                WHEN 'PREFERENTE' THEN 2
                                                ELSE 3 END,
                                             t.creado_en, t.id),
            'creado_en',           t.creado_en,
            'modulo_codigo',       m.codigo
        ) AS fila
        FROM turnos t
        JOIN tramites tr ON tr.id = t.tramite_id
        LEFT JOIN modulos m ON m.id = t.modulo_id
        WHERE t.estado IN ('WAITING','ASIGNED')
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

NOTIFY pgrst, 'reload schema';
