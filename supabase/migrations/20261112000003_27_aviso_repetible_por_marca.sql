-- ===========================================================================
-- 027 — La cola reavisa cuando la llamada es nueva, no solo la primera
-- ===========================================================================
--
-- PROBLEMA
--
-- La regla que saca de la cola a un turno ya llamado era:
--
--     t.estado = 'CALLED'
--     AND t.llamado_en IS NOT NULL
--     AND (s.ultima_activacion IS NULL OR s.ultima_activacion < t.llamado_en)
--
-- Suena correcta, pero no lo es. `ultima_activacion` lo escribe
-- `marcar_aviso_push_enviado` con `clock_timestamp()`, que es la hora real de
-- ese instante; `llamado_en` lo escribe la RPC de la llamada con `now()`,
-- que es el INICIO de la transacción de la llamada. Como el aviso siempre se
-- entrega después de la llamada, `ultima_activacion` queda SIEMPRE un poco
-- después que `llamado_en`. La comparación `ultima_activacion < llamado_en`
-- es, por tanto, falsa desde el primer aviso en adelante: la cola solo
--sacaba el turno una vez y nunca más.
--
-- Se notaba así: se llamaba a un turno, llegaba el aviso, se repetía la
-- llamada y el aviso ya no volvía a salir por el cron (el que dispara la
-- base cada minuto). Solo llegaba el aviso inmediato de la consola.
--
-- SOLUCIÓN
--
-- Se compara la MARCA del aviso, no la hora. La marca identifica la entrega
-- concreta: para el aviso de llamado es `llamado-<folio>-<instante de la
-- llamada>`. Si el operador repite la llamada, el instante cambia, la marca
-- cambia, y la cola vuelve a ofrecer el turno. Si la llamada es la misma,
-- la marca es la misma y no se repite el aviso, que es lo que se quiere.
--
-- La marca ya existe desde la migración 026: es la misma que viaja en el
-- aviso y que el Service Worker pone como `tag` de la notificación. Aquí
-- se guarda en la suscripción, para poder compararla.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) La columna que guarda la marca de la última entrega.
-- ---------------------------------------------------------------------------
ALTER TABLE suscripciones_push
    ADD COLUMN IF NOT EXISTS ultimo_aviso_marca TEXT;

COMMENT ON COLUMN suscripciones_push.ultimo_aviso_marca IS
    'Marca de la ultima entrega (mig 27). Sirve para comparar con la marca del aviso que la cola esta por ofrecer: si son distintas, es un hecho nuevo y hay que avisar.';

-- ---------------------------------------------------------------------------
-- 2) La marca de un turno, calculada siempre igual.
--
-- Es la misma fórmula que usan la cola (mig 26) y el emisor, para que las
-- tres partes hablen del mismo asunto.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_marca_aviso_turno(p_turno turnos)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_turno.aviso_programado_en IS NOT NULL
             AND p_turno.aviso_programado_en <= now()
            THEN 'prog-' || p_turno.folio::TEXT || '-'
                 || floor(extract(epoch FROM p_turno.aviso_programado_en))::TEXT
        WHEN p_turno.estado = 'CALLED' AND p_turno.llamado_en IS NOT NULL
            THEN 'llamado-' || p_turno.folio::TEXT || '-'
                 || floor(extract(epoch FROM p_turno.llamado_en))::TEXT
        ELSE 'cercano-' || p_turno.folio::TEXT
    END
$$;

COMMENT ON FUNCTION fn_marca_aviso_turno(turnos) IS
    'Migracion 27: la marca que identifica un aviso concreto de un turno.';

-- ---------------------------------------------------------------------------
-- 3) Marcar la entrega guarda la marca, no solo la hora.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marcar_aviso_push_enviado(p_turno_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno turnos%ROWTYPE;
BEGIN
    IF p_turno_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE suscripciones_push s
       SET ultima_activacion   = clock_timestamp(),
           ultimo_aviso_marca  = fn_marca_aviso_turno(v_turno)
      FROM turnos t
     WHERE t.id = p_turno_id
       AND s.token_publico = t.token_publico
       AND s.activa;

    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION marcar_aviso_push_enviado(UUID) IS
    'RF-028: registra la entrega (hora y marca) y consume el aviso programado del turno.';

-- ---------------------------------------------------------------------------
-- 4) La cola compara la marca, no la hora.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS suscripciones_por_notificar();

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
    mensaje        TEXT,
    marca          TEXT,
    titulo         TEXT
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
            WHEN COALESCE(v.posicion_global, 999999) <= 1
                THEN 'Su turno ' || t.codigo || ' es el siguiente. Acérquese a la ventanilla.'
            ELSE 'Va ' || (COALESCE(v.posicion_global, 1) - 1)::TEXT || ' turno(s) por delante, unos '
                 || (COALESCE(v.posicion_global, 1) * v_seg_por_turno / 60)::TEXT
                 || ' min. Vaya preparándose: todavía no hace falta que acuda a la ventanilla.'
        END::TEXT,
        fn_marca_aviso_turno(t),
        CASE
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                THEN 'SITUR · Su turno está por llegar'
            WHEN t.estado = 'CALLED'
                THEN 'SITUR · Su turno fue llamado'
            WHEN COALESCE(v.posicion_global, 999999) <= 1
                THEN 'SITUR · Es su turno'
            ELSE 'SITUR · Vaya preparándose'
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
                AND s.ultimo_aviso_marca IS DISTINCT FROM fn_marca_aviso_turno(t)
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
                AND s.ultimo_aviso_marca IS DISTINCT FROM fn_marca_aviso_turno(t)
            )
          )
    ORDER BY t.codigo, t.folio;
END;
$$;

COMMENT ON FUNCTION suscripciones_por_notificar() IS
    'RF-028: turnos a avisar. La entrega se compara por marca, no por hora, para que una llamada repetida vuelva a avisar (mig 27).';

-- ---------------------------------------------------------------------------
-- 5) La suscripción desactivada se reactiva cuando el turno vuelve a estar
--    vivo. Sin esto, un turno que se omitió por timeout (y que por eso
--    desactivó su suscripción) se quedaba sin avisos para siempre.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reactivar_suscripcion_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado NOT IN ('COMPLETED', 'CANCELLED', 'SKIPPED') THEN
        UPDATE suscripciones_push
           SET activa = true
         WHERE token_publico = NEW.token_publico
           AND NOT activa;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_reactivar_suscripcion_push() IS
    'RF-028: un turno que vuelve a un estado vivo reactiva su suscripcion push.';

DROP TRIGGER IF EXISTS trg_turnos_reactivar_suscripcion_push ON turnos;

CREATE TRIGGER trg_turnos_reactivar_suscripcion_push
    AFTER UPDATE OF estado ON turnos
    FOR EACH ROW
    WHEN (NEW.estado NOT IN ('COMPLETED', 'CANCELLED', 'SKIPPED'))
    EXECUTE FUNCTION fn_reactivar_suscripcion_push();

NOTIFY pgrst, 'reload schema';

COMMIT;
