-- ===========================================================================
-- 019 — Historial paginado por turno (fecha + filtro de código)
-- ===========================================================================
-- PROBLEMA
-- `listarHistorial()` trae TODAS las transiciones sin filtro ni paginación.
-- Con 1000 turnos son ~5000 filas en el DOM: el navegador se cuelga.
--
-- SOLUCIÓN
-- Una RPC que devuelve:
--   · los turnos (no las transiciones) que matchean fecha y código,
--   · paginados con LIMIT/OFFSET,
--   · cada turno con sus transiciones anidadas (jsonb),
--   · el total de turnos para el paginador.
--
-- Índices usados: `idx_historial_fecha` (ya existe) y
-- `idx_historial_turno_fecha` (ya existe). No se crean nuevos.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION listar_historial_paginado(
    p_fecha     DATE,
    p_filtro    TEXT DEFAULT NULL,
    p_limite    INTEGER DEFAULT 10,
    p_offset    INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limite INTEGER := LEAST(GREATEST(COALESCE(p_limite, 10), 1), 100);
    v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
    v_filtro TEXT    := NULLIF(btrim(COALESCE(p_filtro, '')), '');
    v_total  INTEGER;
    v_turnos JSONB;
BEGIN
    IF NOT fn_es_administrador() THEN
        RAISE EXCEPTION 'Solo administradores consultan el historial (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    IF p_fecha IS NULL THEN
        RAISE EXCEPTION 'La fecha es obligatoria.' USING ERRCODE = '22023';
    END IF;

    -- Total de turnos que matchean el filtro.
    SELECT COUNT(DISTINCT t.id) INTO v_total
    FROM turnos t
    INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
    WHERE p.clave = p_fecha
      AND (v_filtro IS NULL OR upper(t.codigo) LIKE '%' || upper(v_filtro) || '%');

    -- Turnos de la página, con sus transiciones anidadas.
    SELECT COALESCE(jsonb_agg(turno_completo ORDER BY orden), '[]'::jsonb) INTO v_turnos
    FROM (
        SELECT
            t.id                                 AS orden_id,
            t.creado_en                          AS orden,
            jsonb_build_object(
                'turno_id',       t.id,
                'codigo_turno',   t.codigo,
                'estado_actual',  t.estado,
                'prioridad',      t.prioridad,
                'denominacion_tramite', tr.denominacion,
                'clave_tramite',  tr.clave,
                'transiciones',   COALESCE((
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'turno_id',         h.turno_id,
                            'codigo_turno',     t.codigo,
                            'estado_anterior',  h.estado_anterior,
                            'estado_nuevo',     h.estado_nuevo,
                            'estado_actual',    t.estado,
                            'fecha',            h.fecha,
                            'motivo',           h.motivo,
                            'nombre_usuario',   btrim(concat(u.nombres, ' ', ap.apellido, ' ', coalesce(am.apellido, ''))),
                            'codigo_modulo',    m.codigo,
                            'denominacion_modulo', m.denominacion
                        ) ORDER BY h.fecha
                    )
                    FROM historial_turnos h
                    LEFT JOIN usuarios u  ON u.id = h.usuario_id
                    LEFT JOIN apellidos ap ON ap.id = u.apellido_paterno_id
                    LEFT JOIN apellidos am ON am.id = u.apellido_materno_id
                    LEFT JOIN modulos m   ON m.id = h.modulo_id
                    WHERE h.turno_id = t.id
                ), '[]'::jsonb)
            ) AS turno_completo
        FROM turnos t
        INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
        INNER JOIN tramites tr           ON tr.id = t.tramite_id
        WHERE p.clave = p_fecha
          AND (v_filtro IS NULL OR upper(t.codigo) LIKE '%' || upper(v_filtro) || '%')
        ORDER BY t.creado_en DESC, t.id
        LIMIT v_limite OFFSET v_offset
    ) sub;

    RETURN jsonb_build_object(
        'ok',     true,
        'total',  v_total,
        'limite', v_limite,
        'offset', v_offset,
        'turnos', v_turnos
    );
END;
$$;

COMMENT ON FUNCTION listar_historial_paginado(DATE, TEXT, INTEGER, INTEGER) IS
    'Historial paginado por turno: filtra por fecha del periodo y código, devuelve transiciones anidadas.';

GRANT EXECUTE ON FUNCTION listar_historial_paginado(DATE, TEXT, INTEGER, INTEGER)
    TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
