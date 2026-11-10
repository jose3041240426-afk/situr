-- ===========================================================================
-- 016 — El ciudadano elige con cuánta anticipación quiere el aviso
-- ===========================================================================
BEGIN;

ALTER TABLE turnos
  ADD COLUMN IF NOT EXISTS preferencia_aviso_minutos SMALLINT;

ALTER TABLE turnos
  DROP CONSTRAINT IF EXISTS chk_preferencia_aviso_minutos;

ALTER TABLE turnos
  ADD CONSTRAINT chk_preferencia_aviso_minutos
  CHECK (
    preferencia_aviso_minutos IS NULL
    OR preferencia_aviso_minutos IN (3, 5, 10, 15, 20, 30)
  );

COMMENT ON COLUMN turnos.preferencia_aviso_minutos IS
  'Preferencia del ciudadano: minutos de anticipación para el aviso push. NULL = default del sistema.';

CREATE OR REPLACE FUNCTION actualizar_preferencia_aviso(
    p_token   TEXT,
    p_minutos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno turnos%ROWTYPE;
BEGIN
    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    IF p_minutos IS NOT NULL
       AND p_minutos NOT IN (3, 5, 10, 15, 20, 30) THEN
        RAISE EXCEPTION 'Minutos no validos. Opciones: 3, 5, 10, 15, 20, 30 o NULL.'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE token_publico = btrim(p_token);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Token invalido o inexistente.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.estado <> 'WAITING' THEN
        RAISE EXCEPTION 'Solo se puede cambiar la preferencia mientras el turno esta en espera.'
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos
       SET preferencia_aviso_minutos = p_minutos
     WHERE id = v_turno.id;

    RETURN jsonb_build_object(
        'ok',                        true,
        'preferencia_aviso_minutos', p_minutos,
        'mensaje', CASE
            WHEN p_minutos IS NULL THEN
                'Le avisaremos con la anticipacion del sistema (10 min).'
            ELSE
                format('Le avisaremos %s minutos antes de su turno.', p_minutos)
        END
    );
END;
$$;

COMMENT ON FUNCTION actualizar_preferencia_aviso(TEXT, INTEGER) IS
  'El ciudadano elige con cuanta anticipacion quiere el aviso. Solo con su token, solo en WAITING.';

REVOKE EXECUTE ON FUNCTION actualizar_preferencia_aviso(TEXT, INTEGER)
    FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION actualizar_preferencia_aviso(TEXT, INTEGER) TO anon;

CREATE OR REPLACE FUNCTION get_turno_publico(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno   turnos%ROWTYPE;
    v_tramite tramites%ROWTYPE;
    v_modulo  modulos%ROWTYPE;
    v_pos     INTEGER;
    v_mensaje TEXT;
BEGIN
    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE token_publico = btrim(p_token);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Token invalido o inexistente.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.token_expira_en IS NOT NULL AND v_turno.token_expira_en < now() THEN
        RAISE EXCEPTION 'Token expirado.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;
    SELECT * INTO v_modulo  FROM modulos  WHERE id = v_turno.modulo_id;

    IF v_turno.estado = 'WAITING' THEN
        SELECT posicion INTO v_pos
        FROM vista_cola_espera
        WHERE turno_id = v_turno.id;
    END IF;

    v_mensaje := CASE v_turno.estado
        WHEN 'WAITING'   THEN 'Su turno esta en espera.'
        WHEN 'CALLED'    THEN '¡Su turno fue llamado! Acudase a ' || COALESCE(v_modulo.codigo, 'su modulo') || '.'
        WHEN 'SERVING'   THEN 'Su turno esta siendo atendido.'
        WHEN 'COMPLETED' THEN 'Su turno fue atendido. Gracias.'
        WHEN 'CANCELLED' THEN 'Su turno fue cancelado.'
        WHEN 'SKIPPED'   THEN 'Su turno no fue atendido. Acuda a ventanilla para reposicion.'
        ELSE 'Consulte en ventanilla.'
    END;

    UPDATE turnos
       SET token_ultimo_acceso = now()
     WHERE id = v_turno.id;

    RETURN jsonb_build_object(
        'ok',                        true,
        'codigo_turno',              v_turno.codigo,
        'folio',                     v_turno.folio,
        'estado',                    v_turno.estado,
        'prioridad',                 v_turno.prioridad,
        'denominacion_tramite',      v_tramite.denominacion,
        'posicion',                  COALESCE(v_pos, 0),
        'personas_delante',          GREATEST(COALESCE(v_pos, 1) - 1, 0),
        'modulo',                    v_modulo.codigo,
        'mensaje',                   v_mensaje,
        'creado_en',                 v_turno.creado_en,
        'llamado_en',                v_turno.llamado_en,
        'tiempo_estimado_minutos',   v_turno.tiempo_estimado_mostrado_minutos,
        'token_expira_en',           v_turno.token_expira_en,
        'preferencia_aviso_minutos', v_turno.preferencia_aviso_minutos
    );
END;
$$;

CREATE OR REPLACE FUNCTION suscripciones_por_notificar()
RETURNS TABLE (
    turno_id       UUID,
    endpoint       TEXT,
    clave_p256dh   TEXT,
    clave_auth     TEXT,
    codigo_turno   TEXT,
    folio          INTEGER,
    modulo_codigo  TEXT,
    tipo_aviso     TEXT,
    mensaje        TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_posicion_max   INTEGER := fn_config_entero('POSICION_AVISO_PUSH', 3);
    v_minutos_max    INTEGER := fn_config_entero('MINUTOS_AVISO_PUSH', 10);
    v_seg_por_turno  INTEGER := fn_config_entero('SEGUNDOS_POR_TURNO', 300);
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        s.endpoint,
        s.clave_p256dh,
        s.clave_auth,
        t.codigo,
        t.folio,
        m.codigo,
        CASE
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                                           THEN 'PROGRAMADO'
            WHEN t.estado = 'CALLED'      THEN 'LLAMADO'
            ELSE 'CERCANO'
        END::TEXT,
        CASE
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                THEN 'Su turno ' || t.codigo || ' está por llegar. Por favor acérquese a la ventanilla.'
            WHEN t.estado = 'CALLED'
                THEN 'Su turno fue llamado. Acudase a ' || COALESCE(m.codigo, 'su modulo') || '.'
            ELSE 'Su turno ' || t.codigo || ' está por llegar. Consulte su posición en el portal.'
        END::TEXT
    FROM suscripciones_push s
    INNER JOIN turnos t ON t.token_publico = s.token_publico
    LEFT JOIN modulos m ON m.id = t.modulo_id
    LEFT JOIN vista_cola_espera v ON v.turno_id = t.id
    WHERE s.activa
      AND t.token_expira_en IS NOT NULL
      AND t.token_expira_en > now()
      AND (
            (
                t.aviso_programado_en IS NOT NULL
                AND t.aviso_programado_en <= now()
                AND (s.ultima_activacion IS NULL
                     OR s.ultima_activacion < t.aviso_programado_en)
            )
         OR (
                t.estado = 'WAITING'
                AND s.ultima_activacion IS NULL
                AND (
                    COALESCE(v.posicion_global, 999999) <= v_posicion_max
                    OR (COALESCE(v.posicion_global, 999999) * v_seg_por_turno / 60)
                       <= COALESCE(t.preferencia_aviso_minutos, v_minutos_max)
                )
            )
         OR (
                t.estado = 'CALLED'
                AND t.llamado_en IS NOT NULL
                AND t.aviso_programado_en IS NULL
                AND (s.ultima_activacion IS NULL OR s.ultima_activacion < t.llamado_en)
            )
          )
    ORDER BY t.codigo, t.folio;
END;
$$;

COMMIT;
