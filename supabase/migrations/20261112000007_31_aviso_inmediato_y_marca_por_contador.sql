-- ===========================================================================
-- 031 — El aviso se entrega ya, y no se pierde entre dos llamadas seguidas
-- ===========================================================================
--
-- PROBLEMA 1: EL AVISO PROGRAMADO LLEGABA TARDE
--
-- `programar_aviso_siguiente(10)` guardaba `aviso_programado_en = ahora + 10
-- minutos`, y la cola solo ofrecía ese aviso cuando YA SE HABÍA CUMPLIDO ese
-- plazo (`aviso_programado_en <= now()`). Es decir: el operador pedía
-- «avisa a los que siguen que su turno llega en diez minutos», y el
-- ciudadano recibía el aviso DIEZ MINUTOS DESPUÉS, cuando ya había pasado
-- o el turno se había atendido. Para entonces el aviso no decía nada.
--
-- Lo que se pidió es lo contrario: que el aviso SEA AHORA, diciendo que
-- faltan unos diez minutos. El plazo se guarda como la estimación del
-- operador, y el aviso sale en el acto con ese dato dentro.
--
-- PROBLEMA 2: DOS LLAMADAS SEGUIDAS COMPARTEN MARCA
--
-- La marca identificaba una entrega concreta y era
-- `llamado-<folio>-<segundo de la llamada>`. Dos llamadas al mismo turno
-- dentro del MISMO SEGUNDO producían la misma marca, y por tanto el mismo
-- `tag` de la notificación. En Android y Chrome, una notificación con el
-- `tag` que ya se usó REEMPLAZA a la anterior: el aviso se enviaba, el
-- proveedor lo aceptaba y la pantalla no cambiaba. Por eso el aviso
-- «funcionaba una vez y la siguiente no».
--
-- La marca ahora se apoya en `numero_llamadas`, que es un contador que
-- incrementa en cada llamada (`llamar_siguiente_turno`, `llamar_turno` y
-- `repetir_llamada`). Dos llamadas seguidas tienen números distintos
-- siempre, dentro del mismo segundo o no.
--
-- SOLUCIÓN ADICIONAL: UNA SOLA FUENTE DE VERDAD
--
-- La vía inmediata (la consola) y la del cron (la cola) montaban el aviso
-- cada una por su cuenta, y por eso podían discrepar. Ahora las dos
-- llaman a la misma función de la base, con el mismo criterio, el mismo
-- mensaje y la misma marca. Si mañana cambia el texto, cambia en los dos
-- sitios a la vez.
--
-- `suscripciones_por_notificar` acepta además un turno concreto
-- (p_turno_id): con él, ese turno se avisa aunque ya se le haya avisado
-- antes. Es lo que usa la consola cuando el operador llama a un turno:
-- el aviso se entrega sí o sí, sin esperar al cron.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) La marca: el contador de llamadas, no el reloj.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_marca_aviso_turno(p_turno turnos)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        -- El llamado manda sobre cualquier otro aviso: si el turno ya fue
        -- llamado, lo que el ciudadano necesita saber es eso.
        WHEN p_turno.estado = 'CALLED' AND p_turno.llamado_en IS NOT NULL
            THEN 'llamado-' || p_turno.folio::TEXT || '-' || p_turno.numero_llamadas::TEXT
        -- El aviso programado lleva la hora en que se programó: si el
        -- operador cambia los minutos, cambia la marca y vuelve a avisar.
        WHEN p_turno.aviso_programado_en IS NOT NULL
            THEN 'prog-' || p_turno.folio::TEXT || '-' || floor(extract(epoch FROM p_turno.aviso_programado_en))::TEXT
        ELSE 'cercano-' || p_turno.folio::TEXT
    END
$$;

COMMENT ON FUNCTION fn_marca_aviso_turno(turnos) IS
    'Migracion 31: la marca que identifica un aviso concreto. El llamado se apoya en numero_llamadas, que nunca se repite.';

-- ---------------------------------------------------------------------------
-- 2) Una sola función para las dos vías, con el turno concreto opcional.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS suscripciones_por_notificar();

CREATE OR REPLACE FUNCTION suscripciones_por_notificar(p_turno_id UUID DEFAULT NULL)
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH base AS (
        SELECT
            t.id,
            t.folio,
            t.codigo,
            t.estado,
            t.llamado_en,
            t.numero_llamadas,
            t.aviso_programado_en,
            t.preferencia_aviso_minutos,
            t.token_expira_en,
            s.endpoint,
            s.clave_p256dh,
            s.clave_auth,
            s.activa,
            s.ultima_activacion,
            s.ultimo_aviso_marca,
            m.codigo                                   AS modulo_codigo,
            v.posicion_global,
            v.personas_delante,
            -- Qué AVISO es este turno: el llamado manda sobre el resto.
            CASE
                WHEN t.estado = 'CALLED' AND t.llamado_en IS NOT NULL
                    THEN 'LLAMADO'
                WHEN t.aviso_programado_en IS NOT NULL
                    THEN 'PROGRAMADO'
                ELSE 'CERCANO'
            END                                        AS tipo_aviso,
            -- Y la marca que lo identifica.
            CASE
                WHEN t.estado = 'CALLED' AND t.llamado_en IS NOT NULL
                    THEN 'llamado-' || t.folio::TEXT || '-' || t.numero_llamadas::TEXT
                WHEN t.aviso_programado_en IS NOT NULL
                    THEN 'prog-' || t.folio::TEXT || '-' || floor(extract(epoch FROM t.aviso_programado_en))::TEXT
                ELSE 'cercano-' || t.folio::TEXT
            END                                        AS marca
        FROM turnos t
        INNER JOIN suscripciones_push s ON s.token_publico = t.token_publico
        LEFT JOIN modulos m ON m.id = t.modulo_id
        LEFT JOIN vista_cola_espera v ON v.turno_id = t.id
        WHERE s.activa
          AND t.token_expira_en IS NOT NULL
          AND t.token_expira_en > now()
          AND t.estado IN ('WAITING', 'CALLED', 'SERVING')
          AND (p_turno_id IS NULL OR t.id = p_turno_id)
    ),
    con_datos AS (
        SELECT
            b.*,
            fn_config_entero('POSICION_AVISO_PUSH', 2)      AS posicion_max,
            fn_config_entero('MINUTOS_AVISO_PUSH', 10)       AS minutos_max,
            fn_config_entero('SEGUNDOS_POR_TURNO', 300)      AS seg_por_turno,
            GREATEST(0, round(EXTRACT(EPOCH FROM (b.aviso_programado_en - now())) / 60.0))::INT
                                                            AS minutos_que_faltan
        FROM base b
    )
    SELECT
        d.id,
        d.endpoint,
        d.clave_p256dh,
        d.clave_auth,
        d.codigo,
        d.folio,
        d.modulo_codigo,
        d.tipo_aviso,
        CASE
            WHEN d.tipo_aviso = 'LLAMADO'
                THEN 'Su turno ' || d.codigo || ' fue llamado. Acudase a ' || COALESCE(d.modulo_codigo, 'su modulo') || '.'
            WHEN d.tipo_aviso = 'PROGRAMADO'
                THEN 'Faltan unos ' || d.minutos_que_faltan::TEXT || ' minutos para su turno ' || d.codigo || '. Vaya preparándose.'
            WHEN COALESCE(d.posicion_global, 999999) <= 1
                THEN 'Su turno ' || d.codigo || ' es el siguiente. Acérquese a la ventanilla.'
            ELSE 'Usted es el siguiente en pasar. Prepárese: su turno ' || d.codigo || ' se acerca.'
        END,
        d.marca,
        CASE
            WHEN d.tipo_aviso = 'LLAMADO'
                THEN 'SITUR · Su turno fue llamado'
            WHEN d.tipo_aviso = 'PROGRAMADO'
                THEN 'SITUR · Vaya preparándose'
            WHEN COALESCE(d.posicion_global, 999999) <= 1
                THEN 'SITUR · Es su turno'
            ELSE 'SITUR · Usted sigue'
        END
    FROM con_datos d
    WHERE
        -- Un turno concreto pide su aviso: se entrega sí o sí.
        (p_turno_id IS NOT NULL)
        OR (
            d.ultimo_aviso_marca IS DISTINCT FROM d.marca
            AND (
                -- El aviso programado se entrega EN EL ACTO, no cuando se
                -- cumple el plazo: el plazo es lo que el aviso dice, no
                -- cuándo se envía.
                (d.tipo_aviso = 'PROGRAMADO')
                OR (
                    d.estado = 'WAITING'
                    AND d.ultima_activacion IS NULL
                    AND (
                        (COALESCE(d.posicion_global, 999999) * d.seg_por_turno / 60)
                           <= COALESCE(d.preferencia_aviso_minutos, d.minutos_max)
                        AND COALESCE(d.posicion_global, 999999) <= d.posicion_max
                    )
                )
                OR (
                    d.estado = 'CALLED'
                    AND d.llamado_en IS NOT NULL
                )
            )
        )
    ORDER BY d.codigo, d.folio;
$$;

COMMENT ON FUNCTION suscripciones_por_notificar(UUID) IS
    'RF-028: turnos a avisar. El aviso programado se entrega en el acto (mig 31) y la marca se apoya en numero_llamadas, no en el reloj.';

-- ---------------------------------------------------------------------------
-- 3) Marcar la entrega guarda la MISMA marca que se envió.
--
-- Antes se recalculaba aquí, y podía no coincidir con la que había viajado
-- en el push: la base pensaba que el aviso era otro y lo volvía a ofrecer.
-- Ahora la marca la trae quien envía, que es quien sabe cuál era.
-- ---------------------------------------------------------------------------
-- La versión de un solo argumento se retira: con las dos, PostgreSQL
-- no sabría cuál usar cuando se llama con un argumento, y la de un
-- argumento (la vieja) no guardaba la marca.
DROP FUNCTION IF EXISTS marcar_aviso_push_enviado(UUID);

CREATE OR REPLACE FUNCTION marcar_aviso_push_enviado(p_turno_id UUID, p_marca TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno turnos%ROWTYPE;
    v_marca TEXT;
BEGIN
    IF p_turno_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- La marca que envió el emisor; si no la trae, se calcula aquí.
    v_marca := COALESCE(NULLIF(p_marca, ''), fn_marca_aviso_turno(v_turno));

    UPDATE suscripciones_push s
       SET ultima_activacion   = clock_timestamp(),
           ultimo_aviso_marca  = v_marca
      FROM turnos t
     WHERE t.id = p_turno_id
       AND s.token_publico = t.token_publico
       AND s.activa;

    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION marcar_aviso_push_enviado(UUID, TEXT) IS
    'RF-028: registra la entrega con la marca que se envió, para que la cola no la ofrezca otra vez.';

NOTIFY pgrst, 'reload schema';

COMMIT;
