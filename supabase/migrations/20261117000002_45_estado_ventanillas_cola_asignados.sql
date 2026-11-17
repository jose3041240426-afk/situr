-- ============================================================================
-- Migración 45 — estado_ventanillas: cola incluye ASIGNED + ventanilla (mig 45)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.estado_ventanillas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo  uuid;
    v_cola     jsonb;
    v_vent     jsonb;
    v_mi_modulo uuid;
BEGIN
    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    SELECT u.modulo_id INTO v_mi_modulo
      FROM public.usuarios u
     WHERE u.id = public.fn_usuario_actual();

    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_cola
      FROM (
        SELECT jsonb_build_object(
            'turno_id',             t.id,
            'codigo_turno',         t.codigo,
            'folio',                t.folio,
            'clave_tramite',        tr.clave,
            'denominacion_tramite', tr.denominacion,
            'prioridad',            t.prioridad,
            'estado',               t.estado,
            'posicion',             row_number() OVER (
                                    ORDER BY CASE t.prioridad
                                                WHEN 'URGENTE' THEN 1
                                                WHEN 'PREFERENTE' THEN 2
                                                ELSE 3 END,
                                             t.creado_en, t.id),
            'posicion_llegada',     row_number() OVER (ORDER BY t.creado_en, t.id),
            'creado_en',            t.creado_en,
            'modulo_codigo',        m.codigo
        ) AS fila
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        LEFT JOIN public.modulos m ON m.id = t.modulo_id
        WHERE t.estado IN ('WAITING','ASIGNED')
          AND t.periodo_operativo_id = v_periodo
      ) s;

    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_vent
      FROM (
        SELECT jsonb_build_object(
            'modulo_id',            m.id,
            'codigo',               m.codigo,
            'denominacion',         m.denominacion,
            'estado',               m.estado,
            'activo',               m.activo,
            'estado_ventanilla',    CASE
                                        WHEN NOT (m.activo AND m.estado = 'ACTIVO')
                                            THEN 'SIN_DISPONIBILIDAD'
                                        WHEN a.turno_id IS NOT NULL
                                            THEN 'ATENDIENDO'
                                        ELSE 'DISPONIBLE'
                                    END,
            'disponible',           (m.activo AND m.estado = 'ACTIVO'
                                      AND a.turno_id IS NULL),
            'es_mia',               (m.id = v_mi_modulo),
            'ultima_asignacion_en', m.ultima_asignacion_en,
            'turno_id',             a.turno_id,
            'turno_codigo',         a.codigo,
            'turno_estado',         a.estado,
            'turno_clave_tramite',  tr.clave,
            'turno_denominacion_tramite', tr.denominacion,
            'turno_llamado_en',     a.llamado_en,
            'turno_inicio_atencion', a.inicio_atencion,
            'minutos_en_ventanilla', CASE
                WHEN a.llamado_en IS NULL THEN NULL
                ELSE floor(extract(epoch FROM (now() - a.llamado_en)) / 60)::int
            END,
            'operador_nombres',     u.nombres
        ) AS fila
        FROM public.modulos m
        LEFT JOIN LATERAL (
            SELECT t.id AS turno_id, t.codigo, t.estado, t.tramite_id,
                   t.llamado_en, t.inicio_atencion, t.atendido_por
              FROM public.turnos t
             WHERE t.modulo_id = m.id
               AND t.estado IN ('CALLED', 'SERVING')
             ORDER BY t.llamado_en DESC NULLS LAST, t.id
             LIMIT 1
        ) a ON true
        LEFT JOIN public.tramites tr ON tr.id = a.tramite_id
        LEFT JOIN public.usuarios u ON u.id = a.atendido_por
        ORDER BY m.codigo
      ) s;

    RETURN jsonb_build_object(
        'ok',          true,
        'periodo_id',  v_periodo,
        'cola',        v_cola,
        'ventanillas', v_vent
    );
END;
$$;

NOTIFY pgrst, 'reload schema';
