-- ===========================================================================
-- 033 — RECEPCIÓN puede cerrar periodos y consultar historial
-- ===========================================================================
--
-- CAMBIOS
--   1. RECEPCIÓN ahora puede cerrar el periodo operativo (antes solo
--      ADMINISTRADOR). Se crea fn_puede_cerrar_periodo() y se actualiza
--      cerrar_periodo_operativo() para usarla.
--
--   2. RECEPCIÓN puede consultar el historial paginado (antes solo
--      ADMINISTRADOR). Se actualiza listar_historial_paginado() para
--      aceptar también fn_es_recepcion().
--
--   3. Se añade una política RLS UPDATE para que RECEPCIÓN pueda modificar
--      periodos_operativos (necesaria para que cerrar_periodo_operativo()
--      funcione con RLS habilitado).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permiso para cerrar periodo (RECEPCIÓN + ADMINISTRADOR)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_puede_cerrar_periodo()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM usuarios u
        INNER JOIN roles r ON r.id = u.rol_id
        WHERE u.auth_uid = auth.uid()
          AND u.activo
          AND r.activo
          AND r.clave IN ('ADMINISTRADOR', 'RECEPCION')
    );
$$;

COMMENT ON FUNCTION fn_puede_cerrar_periodo() IS
    'Permite cerrar periodos a ADMINISTRADOR y RECEPCION.';

-- ---------------------------------------------------------------------------
-- 2. Actualizar cerrar_periodo_operativo() para usar fn_puede_cerrar_periodo()
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cerrar_periodo_operativo(p_periodo_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_periodo  periodos_operativos%ROWTYPE;
    v_cerrados INTEGER := 0;
    v_encurso   INTEGER := 0;
    t           turnos%ROWTYPE;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_cerrar_periodo() THEN
        RAISE EXCEPTION 'No tiene permiso para cerrar periodos.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE id = p_periodo_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El periodo no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_periodo.estado <> 'ABIERTO' THEN
        RAISE EXCEPTION 'El periodo ya esta cerrado.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COUNT(*) INTO v_encurso
      FROM turnos
     WHERE periodo_operativo_id = v_periodo.id
       AND estado = 'SERVING';

    IF v_encurso > 0 THEN
        RAISE EXCEPTION 'Hay % turno(s) en atencion; finalicelos o aplique el procedimiento de contingencia.', v_encurso
            USING ERRCODE = 'P0001';
    END IF;

    FOR t IN
        SELECT * FROM turnos
         WHERE periodo_operativo_id = v_periodo.id
           AND estado IN ('WAITING', 'CALLED')
         ORDER BY creado_en
         FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE turnos
           SET estado          = 'SKIPPED',
               saltado_en      = now(),
               saltado_por     = v_operador,
               motivo_salto    = 'CIERRE_JORNADA',
               token_expira_en = calcular_expiracion_token('SKIPPED')
         WHERE id = t.id;

        PERFORM registrar_historial(
            t.id, t.estado, 'SKIPPED', v_operador, t.modulo_id,
            'Jornada cerrada antes de que el turno fuera atendido.',
            jsonb_build_object('categoria', 'CIERRE_JORNADA', 'periodo', v_periodo.clave)
        );

        v_cerrados := v_cerrados + 1;
    END LOOP;

    UPDATE periodos_operativos
       SET estado = 'CERRADO',
           hora_fin = now(),
           cerrado_en = now()
     WHERE id = v_periodo.id;

    PERFORM registrar_auditoria(
        v_operador, 'CERRAR_PERIODO', 'periodos_operativos', v_periodo.id::text, 'EXITO',
        jsonb_build_object('clave', v_periodo.clave, 'turnos_omitidos', v_cerrados)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'periodo_id', v_periodo.id,
        'clave', v_periodo.clave,
        'estado', 'CERRADO',
        'hora_fin', now(),
        'turnos_omitidos_por_cierre', v_cerrados
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Política RLS UPDATE para RECEPCIÓN en periodos_operativos
-- ---------------------------------------------------------------------------
--
-- cerrar_periodo_operativo() hace UPDATE en periodos_operativos.
-- La política p_admin ya cubre ALL para fn_es_administrador(), pero
-- RECEPCIÓN necesita UPDATE explícito para cambiar estado a CERRADO.
-- ---------------------------------------------------------------------------

CREATE POLICY p_recepcion_periodos_update
    ON periodos_operativos
    FOR UPDATE
    TO authenticated
    USING (fn_es_recepcion())
    WITH CHECK (fn_es_recepcion());

-- ---------------------------------------------------------------------------
-- 4. Permitir RECEPCIÓN consultar historial paginado
-- ---------------------------------------------------------------------------
--
-- listar_historial_paginado() solo permite fn_es_administrador().
-- Se actualiza para aceptar también fn_es_recepcion().
-- ---------------------------------------------------------------------------

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
    IF NOT (fn_es_administrador() OR fn_es_recepcion()) THEN
        RAISE EXCEPTION 'No tiene permiso para consultar el historial.'
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
    'Historial paginado por turno: filtra por fecha del periodo y código, devuelve transiciones anidadas. Acceso: ADMINISTRADOR y RECEPCION.';

NOTIFY pgrst, 'reload schema';

COMMIT;
