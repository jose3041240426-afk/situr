-- ===========================================================================
-- 028 — A quién se avisa, y con qué mensaje
-- ===========================================================================
--
-- PROBLEMA
--
-- La cola avisaba por push a los tres primeros de la cola, y a todos con
-- el mismo mensaje: «su turno está por llegar». Con una atención de cinco
-- minutos por turno (SEGUNDOS_POR_TURNO = 300), al que iba segundo le
-- tocaba en DIEZ MINUTOS y al tercero en QUINCE, y los dos recibían lo
-- mismo que el primero: que su turno estaba cerca.
--
-- Para el primero está bien: es su turno, que acuda. Para los otros dos es
-- una señal falsa. El segundo va a estar esperando un cuarto de hora, y si
-- le dicen que su turno está cerca puede soltar lo que tiene a medias y
-- plantarse en la ventanilla, estorbando a quien sí está siendo atendido.
--
-- SOLUCIÓN
--
-- Se avisa a las DOS primeras posiciones, porque a las dos les toca pronto:
-- el primero en cinco minutos y el segundo en diez. A partir de la
-- tercera, quince minutos o más, no es «estar cerca» y no se avisa.
--
-- Y el mensaje cambia según a quién se avisa, para que sea verdad:
--
--   · al que va primero: «Su turno X es el siguiente. Acérquese a la
--     ventanilla.» — a este sí le toca ya.
--   · al que va segundo: «Usted es el siguiente en pasar. Prepárese: su
--     turno X se acerca.» — este sabe que le toca, pero no que sea ya, y
--     que puedearse con calma.
--
-- `POSICION_AVISO_PUSH` pasa a 2: es a cuántas personas se avisa como
-- máximo. La condición de tiempo sigue mandando, así que un ciudadano que
-- pidió aviso «Rápido · 5 min» solo lo recibe cuando es el primero (su
-- posición uno implica cinco minutos de espera), y uno que pidió «Con
-- tiempo · 15 min» lo recibe también siendo el segundo.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) El tope de posiciones baja a 2.
-- ---------------------------------------------------------------------------
UPDATE configuracion
   SET valor = '2',
       descripcion = 'Cuantas personas de la cola reciben aviso de cercanía como máximo. Con una atención de cinco minutos, son el primero (5 min) y el segundo (10 min): a partir del tercero la espera es de quince minutos o más y el aviso sería una señal falsa. El aviso se decide además por el tiempo que falta (MINUTOS_AVISO_PUSH), que es lo que sabe si de verdad está cerca.'
 WHERE clave = 'POSICION_AVISO_PUSH';

-- ---------------------------------------------------------------------------
-- 2) La cola: el tiempo manda, la posición pone el tope, y el mensaje
--    corresponde a la posición real.
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
    v_posicion_max   INTEGER := fn_config_entero('POSICION_AVISO_PUSH', 2);
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
            ELSE 'Usted es el siguiente en pasar. Prepárese: su turno ' || t.codigo || ' se acerca.'
        END::TEXT,
        fn_marca_aviso_turno(t),
        CASE
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                THEN 'SITUR · Su turno está por llegar'
            WHEN t.estado = 'CALLED'
                THEN 'SITUR · Su turno fue llamado'
            WHEN COALESCE(v.posicion_global, 999999) <= 1
                THEN 'SITUR · Es su turno'
            ELSE 'SITUR · Usted sigue'
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
                    -- El tiempo que falta manda: es lo que sabe si el aviso
                    -- es una señal o una falsedad. La posición solo pone el
                    -- tope de a cuántas personas se avisa.
                    (COALESCE(v.posicion_global, 999999) * v_seg_por_turno / 60)
                       <= COALESCE(t.preferencia_aviso_minutos, v_minutos_max)
                    AND COALESCE(v.posicion_global, 999999) <= v_posicion_max
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
    'RF-028: turnos a avisar. El aviso de cercania lo decide el tiempo que falta y el mensaje corresponde a la posicion (mig 28); la entrega se compara por marca (mig 27).';

NOTIFY pgrst, 'reload schema';

COMMIT;
