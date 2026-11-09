-- ===========================================================================
-- 014 — El aviso programado alcanza a los próximos, no solo al primero
-- ===========================================================================
--
-- QUÉ ESTABA MAL
-- Con tres turnos en «En atención ahora», el operador pulsaba «15 min» y solo
-- se programaba el aviso del PRIMERO de la cola. Los dos que venían detrás se
-- enteraban cuando ya estaban llamados, sin la anticipación que el operador
-- acababa de prometer. Si dos de los tres están por terminar, en quince
-- minutos se habrá llamado a los tres siguientes, no a uno.
--
-- LA REGLA NUEVA
-- Se avisa a tantos turnos como lugares de atención ocupados haya en ese
-- momento (CALLED + SERVING), con un mínimo de uno. Con la jornada vacía se
-- avisa al siguiente, que es lo que hacía antes; con tres abiertos se avisan
-- los tres siguientes. Todos reciben el push a la hora elegida.
--
-- POR QUÉ LOS LUGARES OCUPADOS Y NO UNA CIFRA FIJA
-- Es la única cifra que el operador ve en pantalla («2 de 3») y la que
-- describe cuántos turnos van a desfilar por la ventanilla en ese plazo. Una
-- constante (siempre tres) avisaría de más con la cola vacía y de menos si la
-- dependencia sube MAXIMO_TURNOS_EN_ATENCION.
--
-- POR QUÉ TODOS A LA MISMA HORA
-- El aviso no reserva la ventanilla: solo dice «acérquese». Escalonarlos
-- exigiría inventar cuánto tarda cada atención, que es justo el dato que el
-- sistema no tiene. Avisar un poco antes de tiempo es inofensivo; no avisar,
-- no.
--
-- EL TEXTO DEL PUSH
-- Decía «Su turno es el siguiente» a los tres, y era falso para dos. Ahora
-- dice «está por llegar», que es cierto para todos.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. programar_aviso_siguiente: de uno a K turnos
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION programar_aviso_siguiente(
    p_minutos INTEGER,
    p_tramite_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador  UUID;
    v_permiso   INTEGER[];
    v_momento   TIMESTAMPTZ;
    v_abiertos  INTEGER;
    v_cantidad  INTEGER;
    v_turno     turnos%ROWTYPE;
    v_tramite   tramites%ROWTYPE;
    v_turnos    JSONB := '[]'::JSONB;
BEGIN
    -- [1] VALIDA -----------------------------------------------------------
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para programar avisos.'
            USING ERRCODE = '42501';
    END IF;

    v_permiso := opciones_aviso_minutos();
    IF p_minutos IS NULL OR NOT (p_minutos = ANY (v_permiso)) THEN
        RAISE EXCEPTION 'Minutos no validos. Las opciones son: %.', array_to_string(v_permiso, ', ')
            USING ERRCODE = '22023';
    END IF;

    -- [2] ¿CUÁNTOS TURNOS VAN A PASAR POR LA VENTANILLA? -------------------
    -- Los que están llamados o en atención ahora: en el plazo elegido, la
    -- cola avanzará aproximadamente esos lugares. Nunca menos de uno.
    SELECT COUNT(*)
      INTO v_abiertos
      FROM turnos t
      INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
     WHERE p.estado = 'ABIERTO'
       AND t.estado IN ('CALLED', 'SERVING');

    v_cantidad := GREATEST(1, v_abiertos);

    -- [3] PROGRAMA A LOS K SIGUIENTES --------------------------------------
    -- Mismo orden que llamar_siguiente_turno (RN-017), para que «los
    -- siguientes» sean exactamente los que se van a llamar.
    v_momento := clock_timestamp() + make_interval(mins => p_minutos);

    FOR v_turno IN
        SELECT t.*
          FROM turnos t
          INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
         WHERE p.estado = 'ABIERTO'
           AND t.estado = 'WAITING'
           AND (p_tramite_id IS NULL OR t.tramite_id = p_tramite_id)
         ORDER BY
            CASE t.prioridad
                WHEN 'URGENTE'    THEN 1
                WHEN 'PREFERENTE' THEN 2
                ELSE 3
            END,
            t.creado_en,
            t.id
         LIMIT v_cantidad
         FOR UPDATE OF t
    LOOP
        UPDATE turnos
           SET aviso_programado_en  = v_momento,
               aviso_programado_por = v_operador
         WHERE id = v_turno.id;

        SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

        PERFORM registrar_historial(
            v_turno.id, v_turno.estado, v_turno.estado, v_operador, NULL,
            format('Aviso programado para dentro de %s minutos.', p_minutos),
            jsonb_build_object('aviso_programado_en', v_momento, 'minutos', p_minutos)
        );

        PERFORM registrar_auditoria(
            v_operador, 'PROGRAMAR_AVISO', 'turnos', v_turno.id::text, 'EXITO',
            jsonb_build_object(
                'minutos', p_minutos,
                'codigo', v_turno.codigo,
                'lugares_ocupados', v_abiertos,
                'total_avisados', v_cantidad
            )
        );

        v_turnos := v_turnos || jsonb_build_object(
            'turno_id',      v_turno.id,
            'codigo',        v_turno.codigo,
            'folio',         v_turno.folio,
            'clave_tramite', v_tramite.clave
        );
    END LOOP;

    IF v_turnos = '[]'::JSONB THEN
        RAISE EXCEPTION 'No hay turnos en espera para avisar.'
            USING ERRCODE = 'P0004';
    END IF;

    -- [4] EMITE ------------------------------------------------------------
    RETURN jsonb_build_object(
        'ok',                  true,
        'minutos',             p_minutos,
        'aviso_programado_en', v_momento,
        'lugares_ocupados',    v_abiertos,
        'total',               jsonb_array_length(v_turnos),
        'turnos',              v_turnos
    );
END;
$$;

COMMENT ON FUNCTION programar_aviso_siguiente IS
    'Avisa a los próximos turnos de la cola: uno por cada lugar de atención ocupado (CALLED+SERVING), mínimo uno. Todos reciben el push a la hora elegida.';


-- ---------------------------------------------------------------------------
-- 2. El texto del push deja de decir «es el siguiente» a todos
-- ---------------------------------------------------------------------------
-- Se reemplaza la función de 009 sin tocar su lógica: CERCANO por posición
-- real, LLAMADO por cada llamada y PROGRAMADO por la hora del operador. Solo
-- cambia el mensaje del PROGRAMADO, que ahora puede ir dirigido a varios
-- turnos de la cola a la vez.

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
    v_posicion_max INTEGER := fn_config_entero('POSICION_AVISO_PUSH', 3);
    v_minutos_max  INTEGER := fn_config_entero('MINUTOS_AVISO_PUSH', 10);
    v_seg_por_turno INTEGER := fn_config_entero('SEGUNDOS_POR_TURNO', 300);
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
            WHEN t.estado = 'CALLED'      THEN 'LLAMADO'
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                                          THEN 'PROGRAMADO'
            ELSE 'CERCANO'
        END::TEXT,
        CASE
            WHEN t.estado = 'CALLED'
                THEN 'Su turno fue llamado. Acudase a ' || COALESCE(m.codigo, 'su modulo') || '.'
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                THEN 'Su turno ' || t.codigo || ' esta por llegar. Por favor acerquese a la ventanilla.'
            ELSE 'Su turno ' || t.codigo || ' esta por llegar. Consulte su posicion en el portal.'
        END::TEXT
    FROM suscripciones_push s
    INNER JOIN turnos t ON t.token_publico = s.token_publico
    LEFT JOIN modulos m ON m.id = t.modulo_id
    LEFT JOIN vista_cola_espera v ON v.turno_id = t.id
    WHERE s.activa
      AND t.token_expira_en IS NOT NULL
      AND t.token_expira_en > now()
      AND (
            -- PROGRAMADO: el operador ya fijó la hora y ya llegó.
            (
                t.estado = 'WAITING'
                AND t.aviso_programado_en IS NOT NULL
                AND t.aviso_programado_en <= now()
                AND (s.ultima_activacion IS NULL
                     OR s.ultima_activacion < t.aviso_programado_en)
            )
            -- CERCANO: posición real en la cola, o tiempo restante calculado
            -- con los turnos que quedan delante. NO se usa el estimado
            -- congelado del ticket: en una emisión masiva todos valen lo mismo.
         OR (
                t.estado = 'WAITING'
                AND s.ultima_activacion IS NULL
                AND (
                    COALESCE(v.posicion_global, 999999) <= v_posicion_max
                    OR (COALESCE(v.posicion_global, 999999) * v_seg_por_turno / 60) <= v_minutos_max
                )
            )
            -- LLAMADO: una vez por cada llamada.
         OR (
                t.estado = 'CALLED'
                AND t.llamado_en IS NOT NULL
                AND (s.ultima_activacion IS NULL OR s.ultima_activacion < t.llamado_en)
            )
          )
    ORDER BY t.codigo, t.folio;
END;
$$;

COMMENT ON FUNCTION suscripciones_por_notificar IS
    'RF-028: cola de avisos. PROGRAMADO (aviso manual del operador, ahora para varios turnos), CERCANO por posición y LLAMADO. Nunca devuelve el token ni PII.';

COMMIT;
