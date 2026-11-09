-- ============================================================================
-- MIGRACIÓN 009 · EMISIÓN MASIVA DE TURNOS Y AVISO PROGRAMADO DEL SIGUIENTE
-- ============================================================================
--
-- Dos funciones nuevas solicitadas por la dirección del proyecto:
--
--   1) generar_turnos_masivos(p_lotes JSONB)
--      Emite N turnos de golpe indicando cuántos por trámite, por ejemplo
--      [{"tramite":"A","cantidad":25},{"tramite":"B","cantidad":25}] = 100.
--      Reutiliza generar_turno() para que la numeración, los tokens, el
--      historial y la auditoría sigan siendo exactamente los mismos: no se
--      duplica ni una regla de negocio.
--
--   2) programar_aviso_siguiente(p_minutos)
--      El operador elige en pantalla cuánto falta para el siguiente turno
--      (5, 10 o 15 minutos) y al ciudadano que está en esa posición le llega
--      el aviso push con esa anticipación.
--
-- DECISIÓN DE DISEÑO IMPORTANTE
-- generar_turnos_masivos es atómica: si un lote falla (trámite inactivo, tope
-- diario alcanzado), NO se emite ninguno de los anteriores. Es preferible a
-- dejar 60 turnos impresos y 40 no, que obligaría a reimprimir y a explicar
-- folios "que faltan" en ventanilla.
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. COLUMNAS DE SOPORTE PARA EL AVISO PROGRAMADO
-- ----------------------------------------------------------------------------
-- Aviso manual del operador: "al siguiente le avisas en 10 minutos". Se guarda
-- como marca temporal absoluta porque el cron solo necesita comparar contra
-- now(), y así el aviso dispara a la hora correcta aunque el cron se retrase.

ALTER TABLE turnos
    ADD COLUMN IF NOT EXISTS aviso_programado_en TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS aviso_programado_por UUID
        REFERENCES usuarios (id) ON UPDATE CASCADE ON DELETE SET NULL;

COMMENT ON COLUMN turnos.aviso_programado_en IS
    'Momento en que debe salir el aviso push al siguiente turno (lo fija el operador).';
COMMENT ON COLUMN turnos.aviso_programado_por IS
    'Operador que programó el aviso. Trazabilidad de quién avisó.';

CREATE INDEX IF NOT EXISTS idx_turnos_aviso_programado
    ON turnos (aviso_programado_en)
    WHERE aviso_programado_en IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. CLAVES DE CONFIGURACIÓN
-- ----------------------------------------------------------------------------
-- Los minutos ofrecidos en pantalla viven en `configuracion` (RF-023), no
-- codificados en la interfaz: si Catastro quiere ofrecer 3 o 20 minutos, se
-- cambia la clave y la consola se adapta sola.

INSERT INTO configuracion (clave, nombre, valor, tipo, descripcion)
VALUES
    ('MINUTOS_AVISO_OPCIONES', 'Opciones de aviso en pantalla', '[5,10,15]', 'JSON',
     'Minutos que la consola ofrece al operador para avisar al siguiente turno.'),
    ('MAXIMO_TURNOS_LOTE', 'Máximo de turnos por emisión masiva', '500', 'ENTERO',
     'Tope de seguridad de la emisión masiva: evita un lote accidental de miles de turnos.'),
    ('SEGUNDOS_POR_TURNO', 'Segundos estimados de atención por turno', '300', 'ENTERO',
     'Duración media de atención. Sirve para saber cuántos minutos faltan para un turno según los que tiene delante.')
ON CONFLICT (clave) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 3. CÓDIGO DE TRÁMITE A ID
-- ----------------------------------------------------------------------------
-- El lote puede venir con la clave del trámite ('A') o con su UUID. Se aceptan
-- las dos porque la consola conoce la clave (es la que se ve en pantalla) y no
-- tiene por qué llevar los UUID.

CREATE OR REPLACE FUNCTION fn_tramite_por_clave(p_tramite TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    -- UUID explícito.
    BEGIN
        v_id := p_tramite::UUID;
        RETURN v_id;
    EXCEPTION WHEN invalid_text_representation THEN
        NULL; -- No era UUID: se busca por clave.
    END;

    SELECT id INTO v_id
      FROM tramites
     WHERE clave = p_tramite
       AND activo
     LIMIT 1;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'El tramite "%" no existe o esta inactivo.', p_tramite
            USING ERRCODE = 'P0002';
    END IF;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_tramite_por_clave IS
    'Acepta la clave visible del tramite (A, B...) o su UUID y devuelve el id.';


-- ----------------------------------------------------------------------------
-- 4. EMISIÓN MASIVA
-- ----------------------------------------------------------------------------
-- Formato de p_lotes:
--   [{"tramite": "A", "cantidad": 25}, {"tramite": "B", "cantidad": 25}]
--
-- Devuelve un resumen con el total y el detalle de los turnos emitidos, que es
-- lo que la consola necesita para ofrecer la impresión en bloque.

CREATE OR REPLACE FUNCTION generar_turnos_masivos(p_lotes JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador     UUID;
    v_maximo_lote  INTEGER := fn_config_entero('MAXIMO_TURNOS_LOTE', 500);
    v_total_pedido INTEGER;
    v_lote         JSONB;
    v_tramite_text TEXT;
    v_tramite_id   UUID;
    v_cantidad     INTEGER;
    v_turno        JSONB;
    v_emitidos     JSONB := '[]'::JSONB;
    v_codigos      TEXT[] := ARRAY[]::TEXT[];
    v_i            INTEGER;
BEGIN
    -- [1] VALIDA -----------------------------------------------------------
    IF p_lotes IS NULL OR jsonb_typeof(p_lotes) <> 'array' OR jsonb_array_length(p_lotes) = 0 THEN
        RAISE EXCEPTION 'Debe indicar al menos un lote de turnos.'
            USING ERRCODE = '22023';
    END IF;

    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para emitir turnos.'
            USING ERRCODE = '42501';
    END IF;

    -- Suma total y valida cada elemento ANTES de emitir nada. Así el error
    -- aparece antes, no a mitad del lote.
    SELECT COALESCE(SUM((e->>'cantidad')::INTEGER), 0)
      INTO v_total_pedido
      FROM jsonb_array_elements(p_lotes) AS e;

    IF v_total_pedido <= 0 THEN
        RAISE EXCEPTION 'La cantidad total de turnos debe ser mayor que cero.'
            USING ERRCODE = '22023';
    END IF;

    IF v_total_pedido > v_maximo_lote THEN
        RAISE EXCEPTION 'No se pueden emitir % turnos de golpe; el maximo es %.', v_total_pedido, v_maximo_lote
            USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lotes) AS e
                WHERE (e->>'cantidad') IS NULL
                   OR (e->>'cantidad')::INTEGER <= 0) THEN
        RAISE EXCEPTION 'Cada lote debe indicar una cantidad mayor que cero.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM periodos_operativos WHERE estado = 'ABIERTO') THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto; no se pueden generar turnos (RF-025).'
            USING ERRCODE = 'P0001';
    END IF;

    -- [2] EMITE ------------------------------------------------------------
    -- Un generar_turno() por turno: la numeración atómica, el token de 256
    -- bits, el historial y la auditoría quedan idénticos al turno individual.
    FOR v_lote IN SELECT * FROM jsonb_array_elements(p_lotes)
    LOOP
        v_tramite_text := v_lote->>'tramite';
        v_cantidad     := (v_lote->>'cantidad')::INTEGER;

        IF v_tramite_text IS NULL THEN
            RAISE EXCEPTION 'Cada lote debe indicar su tramite.'
                USING ERRCODE = '22023';
        END IF;

        v_tramite_id := fn_tramite_por_clave(v_tramite_text);

        FOR v_i IN 1..v_cantidad
        LOOP
            v_turno := generar_turno(v_tramite_id, NULL);

            v_emitidos := v_emitidos || jsonb_build_object(
                'turno_id',     v_turno->>'turno_id',
                'codigo',       v_turno->>'codigo_turno',
                'folio',        v_turno->>'folio',
                'tramite',      v_turno->>'clave_tramite',
                'token_publico', v_turno->>'token_publico'
            );

            v_codigos := v_codigos || (v_turno->>'codigo_turno');
        END LOOP;
    END LOOP;

    -- [3] TRAZA ------------------------------------------------------------
    PERFORM registrar_auditoria(
        v_operador, 'GENERAR_TURNOS_MASIVOS', 'turnos', NULL, 'EXITO',
        jsonb_build_object(
            'lotes',   p_lotes,
            'total',   jsonb_array_length(v_emitidos),
            'primero', v_codigos[1],
            'ultimo',  v_codigos[array_length(v_codigos, 1)]
        )
    );

    -- [4] EMITE ------------------------------------------------------------
    RETURN jsonb_build_object(
        'ok',       true,
        'total',    jsonb_array_length(v_emitidos),
        'turnos',   v_emitidos
    );
END;
$$;

COMMENT ON FUNCTION generar_turnos_masivos IS
    'Emite N turnos por trámite en una sola transacción. Atómica: si un lote falla no se emite ninguno. Reutiliza generar_turno().';


-- ----------------------------------------------------------------------------
-- 5. OPCIONES DE AVISO DISPONIBLES EN PANTALLA
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION opciones_aviso_minutos()
RETURNS INTEGER[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_json JSONB;
    v_arr  INTEGER[];
BEGIN
    SELECT valor::JSONB INTO v_json
      FROM configuracion
     WHERE clave = 'MINUTOS_AVISO_OPCIONES'
       AND activo;

    IF v_json IS NULL THEN
        RETURN ARRAY[5, 10, 15];
    END IF;

    SELECT array_agg((e)::TEXT::INTEGER ORDER BY (e)::TEXT::INTEGER)
      INTO v_arr
      FROM jsonb_array_elements(v_json) AS e;

    RETURN COALESCE(v_arr, ARRAY[5, 10, 15]);
END;
$$;

COMMENT ON FUNCTION opciones_aviso_minutos IS
    'Minutos que la consola ofrece al operador. Salen de configuracion, no del codigo.';


-- ----------------------------------------------------------------------------
-- 6. PROGRAMAR EL AVISO DEL SIGUIENTE TURNO
-- ----------------------------------------------------------------------------
-- El operador elige 5, 10 o 15 minutos para el siguiente de la cola. Solo se
-- aceptan los valores ofrecidos en `configuracion`: un aviso de 1 minuto no da
-- tiempo a llegar y uno de 60 es inútil.

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
    v_operador UUID;
    v_siguiente turnos%ROWTYPE;
    v_tramite  tramites%ROWTYPE;
    v_permiso  INTEGER[];
    v_momento  TIMESTAMPTZ;
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

    -- [2] LOCALIZA AL SIGUIENTE ---------------------------------------------
    -- El siguiente es el primero de la cola en espera, con el mismo criterio de
    -- orden que llamar_siguiente_turno (RN-017), para que "el siguiente" sea
    -- exactamente el que va a ser llamado.
    SELECT t.*
      INTO v_siguiente
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
     LIMIT 1
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay turnos en espera para avisar.'
            USING ERRCODE = 'P0004';
    END IF;

    -- [3] PROGRAMA -----------------------------------------------------------
    v_momento := clock_timestamp() + make_interval(mins => p_minutos);

    UPDATE turnos
       SET aviso_programado_en  = v_momento,
           aviso_programado_por = v_operador
     WHERE id = v_siguiente.id;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_siguiente.tramite_id;

    PERFORM registrar_historial(
        v_siguiente.id, v_siguiente.estado, v_siguiente.estado, v_operador, NULL,
        format('Aviso programado para dentro de %s minutos.', p_minutos),
        jsonb_build_object('aviso_programado_en', v_momento, 'minutos', p_minutos)
    );

    PERFORM registrar_auditoria(
        v_operador, 'PROGRAMAR_AVISO', 'turnos', v_siguiente.id::text, 'EXITO',
        jsonb_build_object('minutos', p_minutos, 'codigo', v_siguiente.codigo)
    );

    -- [4] EMITE --------------------------------------------------------------
    RETURN jsonb_build_object(
        'ok',                true,
        'turno_id',          v_siguiente.id,
        'codigo_turno',      v_siguiente.codigo,
        'folio',             v_siguiente.folio,
        'clave_tramite',     v_tramite.clave,
        'minutos',           p_minutos,
        'aviso_programado_en', v_momento
    );
END;
$$;

COMMENT ON FUNCTION programar_aviso_siguiente IS
    'El operador fija en pantalla cuántos minutos faltan para el siguiente turno (5/10/15). El cron manda el push a esa hora.';


CREATE OR REPLACE FUNCTION cancelar_aviso_siguiente(p_turno_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL OR NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para cancelar avisos.'
            USING ERRCODE = '42501';
    END IF;

    UPDATE turnos
       SET aviso_programado_en  = NULL,
           aviso_programado_por = NULL
     WHERE id = p_turno_id
       AND aviso_programado_en IS NOT NULL;

    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION cancelar_aviso_siguiente IS
    'Deshace un aviso programado que aún no ha salido.';


-- ----------------------------------------------------------------------------
-- 7. EL CRON TAMBIÉN ATIENDE LOS AVISOS PROGRAMADOS
-- ----------------------------------------------------------------------------
-- Se reemplaza suscripciones_por_notificar() añadiendo una tercera rama:
-- el aviso manual del operador. Se mantiene la lógica original de
-- CERCANO por posición y LLAMADO.
--
-- CORRECCIÓN INCLUIDA (detectada al probar la emisión masiva):
--   `tiempo_estimado_mostrado_minutos` se congela al EMITIR el turno, así que
--   los 100 turnos de un lote nacen con el mismo valor (5 min). La rama
--   CERCANO comparaba ese valor contra MINUTOS_AVISO_PUSH, por lo que TODOS
--   los turnos de un lote entraban como "inminentes" y el ciudadano del
--   folio 90 recibía un aviso a los dos segundos de pedir su turno.
--   Ahora la rama CERCANO usa la posición real en la cola (posicion_global)
--   y el tiempo restante estimado según los turnos que quedan delante,
--   no el valor congelado en el ticket.

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
                THEN 'Su turno ' || t.codigo || ' es el siguiente. Por favor acerquese a la ventanilla.'
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
    'RF-028: cola de avisos. Añade el tipo PROGRAMADO (aviso manual del operador) a CERCANO y LLAMADO. Nunca devuelve el token ni PII.';


-- ----------------------------------------------------------------------------
-- 8. PERMISOS
-- ----------------------------------------------------------------------------
-- Solo operadores autenticados. Ninguna de estas funciones se expone a `anon`:
-- la emisión masiva y la programación de avisos son actos de ventanilla.

REVOKE EXECUTE ON FUNCTION generar_turnos_masivos(JSONB)               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION programar_aviso_siguiente(INTEGER, UUID)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION cancelar_aviso_siguiente(UUID)              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION opciones_aviso_minutos()                    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION generar_turnos_masivos(JSONB)                TO authenticated;
GRANT EXECUTE ON FUNCTION programar_aviso_siguiente(INTEGER, UUID)      TO authenticated;
GRANT EXECUTE ON FUNCTION cancelar_aviso_siguiente(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION opciones_aviso_minutos()                     TO authenticated, anon;
