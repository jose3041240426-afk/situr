-- ===========================================================================
-- 023 — El aviso de «llamado» no se queda esperando a un aviso programado
-- ===========================================================================
--
-- PROBLEMA
-- Cuando el operador programaba un aviso para el siguiente turno, se ponía
-- `aviso_programado_en` en ese turno. La regla de «llamado» de la cola de
-- avisos exigía `aviso_programado_en IS NULL`, así que el aviso inmediato
-- quedaba bloqueado hasta que pasara la hora programada (y a veces nunca, si
-- el cron no corría a tiempo). El ciudadano veía «Aviso activado» y no
-- recibía nada.
--
-- SOLUCIÓN
-- La regla de «llamado» se dispara cuando el turno se llama, sin importar
-- si había un aviso programado: el que manda es el evento (CALLED), no el
-- reloj. Y al enviar cualquier aviso, se borra `aviso_programado_en` del
-- turno para que no se repita después.
-- ===========================================================================

BEGIN;

-- 1) La regla de «llamado» no se bloquea por un aviso programado.
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
                AND (s.ultima_activacion IS NULL OR s.ultima_activacion < t.llamado_en)
            )
          )
    ORDER BY t.codigo, t.folio;
END;
$$;

-- 2) Al entregar un aviso, se borra el programado del turno para que no se
--    repita después. `marcar_aviso_push_enviado` solo tocaba la suscripción.
CREATE OR REPLACE FUNCTION marcar_aviso_push_enviado(p_turno_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_turno_id IS NULL THEN
        RETURN FALSE;
    END IF;

    UPDATE suscripciones_push s
       SET ultima_activacion = clock_timestamp()
      FROM turnos t
     WHERE t.id = p_turno_id
       AND s.token_publico = t.token_publico
       AND s.activa;

    -- El aviso programado ya se entregó: no vuelve a dispararse.
    UPDATE turnos
       SET aviso_programado_en = NULL
     WHERE id = p_turno_id;

    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION suscripciones_por_notificar() IS
    'RF-028: turnos a avisar. El llamado no se bloquea por un aviso programado.';
COMMENT ON FUNCTION marcar_aviso_push_enviado(UUID) IS
    'RF-028: registra la entrega y consume el aviso programado del turno.';

REVOKE EXECUTE ON FUNCTION marcar_aviso_push_enviado(UUID) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
