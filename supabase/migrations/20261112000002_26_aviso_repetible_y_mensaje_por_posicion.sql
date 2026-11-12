-- ===========================================================================
-- 026 — El aviso se puede repetir, y su mensaje dice lo que corresponde
-- ===========================================================================
--
-- PROBLEMA 1: EL AVISO SÓLO SE PUEDE DAR UNA VEZ
--
-- Cuando el Service Worker muestra una notificación, le pone un `tag` con
-- el folio del turno. El propósito del `tag` es que una notificación nueva
-- REEMPLACE a la anterior del mismo turno, en vez de acumularse. Pero en
-- Android y Chrome ese `tag` tiene un efecto secundario: cuando el usuario
-- DESCARTA la notificación (la quita con el dedo), el navegador la recuerda
-- y **no vuelve a mostrar ninguna otra con ese mismo `tag`**. El aviso se
-- envía, el proveedor de push lo acepta y el mensaje desaparece.
--
-- Se notaba así: se llamaba a un turno, llegaba el aviso, se quitaba y,
-- al volver a llamarlo, no llegaba nada. El servidor sí lo enviaba
-- (`enviados: 1`), pero el navegador no lo mostraba.
--
-- SOLUCIÓN: el `tag` pasa a llevar una MARCA, que es lo que distingue una
-- entrega de otra. Se cambia cuando cambia el hecho que la justifica:
--   · el llamado: la marca es la hora de la llamada, así que cada llamada
--     repetida es una notificación nueva y se vuelve a mostrar;
--   · el aviso programado: la marca es la hora programada;
--   · el aviso de cercanía: la marca es fija, porque ese aviso se da una
--     sola vez por turno (la cola solo lo saca si el ciudadano aún no
--     ha recibido ninguno).
--
-- PROBLEMA 2: EL MENSAJE NO DICE CUÁNTO FALTA
--
-- La cola avisaba igual a los tres primeros de la cola con «su turno está
-- por llegar». Pero al tercero le quedan hasta quince minutos: con una
-- atención de cinco minutos, tres turnos por delante son quince minutos de
-- espera. Decirle a alguien «su turno está cerca» cuando en realidad falta
-- un cuarto de hora es una mala señal, y hace que el ciudadano acuda antes
-- de tiempo y estorbe a quien sí está siendo atendido.
--
-- SOLUCIÓN: el mensaje se calcula con la posición real. Al que va primero
-- se le dice que su turno es el siguiente; a los que van detrás se les
-- dice cuántos turnos tiene delante y cuántos minutos son, para que se
-- preparen sin salir antes de tiempo.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- La función de la cola, con la marca y con el mensaje según la posición.
--
-- Se suelta antes de redefinirla: al cambiar la lista de columnas que
-- devuelve, PostgreSQL no admite el CREATE OR REPLACE y pide un DROP
-- explícito. No hay ventana de alarma porque la función se recrea dentro
-- de la misma transacción.
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
        -- El mensaje dice la verdad sobre cuánto falta.
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
        -- La marca distingue una entrega de otra. El Service Worker la usa
        -- como `tag` de la notificación, para que un aviso repetido se
        -- vuelva a mostrar en vez de quedar eclipsado por el anterior.
        CASE
            WHEN t.aviso_programado_en IS NOT NULL AND t.aviso_programado_en <= now()
                THEN 'prog-' || t.folio::TEXT || '-' || floor(extract(epoch FROM t.aviso_programado_en))::TEXT
            WHEN t.estado = 'CALLED'
                THEN 'llamado-' || t.folio::TEXT || '-' || floor(extract(epoch FROM t.llamado_en))::TEXT
            ELSE 'cercano-' || t.folio::TEXT
        END::TEXT,
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

COMMENT ON FUNCTION suscripciones_por_notificar() IS
    'RF-028: turnos a avisar, con la marca que identifica cada entrega y el mensaje segun la posicion real en la cola.';

NOTIFY pgrst, 'reload schema';

COMMIT;
