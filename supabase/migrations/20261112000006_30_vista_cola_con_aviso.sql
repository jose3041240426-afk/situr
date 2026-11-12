-- ===========================================================================
-- 030 — La vista de la cola dice si el turno ya tiene aviso programado
-- ===========================================================================
--
-- PROBLEMA
--
-- La consola listaba la cola con `vista_cola_espera`, que no traía
-- `aviso_programado_en`. La consecuencia era que el operador no podía ver
-- qué turnos de la cola tenían aviso programado ni cancelarlo: la columna
-- no existía en el tipo, y la RPC `cancelar_aviso_siguiente` estaba
-- escrita pero nadie la llamaba desde la interfaz.
--
-- Con la migración 029 el aviso propio se reprograma, así que el error de
-- «todos tienen aviso programado» ya no aparece. Pero cancelar un aviso
-- sigue siendo necesario: si el operador se equivocó de minutos, o si el
-- aviso ya no tiene sentido porque la cola cambió, tiene que poder
-- quitarlo. Para eso la fila de la cola tiene que decir qué turnos lo
-- tienen.
--
-- SOLUCIÓN
--
-- Se añade `aviso_programado_en` a la vista de la cola, junto con el
-- operador que lo programó, para que la consola pueda mostrar «aviso
-- programado» en la fila y ofrecer la cancelación.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE VIEW vista_cola_espera AS
WITH orden AS (
    SELECT
        t.id,
        t.folio,
        t.codigo,
        t.periodo_operativo_id,
        t.tramite_id,
        t.prioridad,
        t.creado_en,
        t.tiempo_estimado_mostrado_minutos,
        t.reclamado_en,
        t.aviso_programado_en,
        ROW_NUMBER() OVER (
            PARTITION BY t.periodo_operativo_id, t.tramite_id
            ORDER BY
                CASE t.prioridad
                    WHEN 'URGENTE'    THEN 1
                    WHEN 'PREFERENTE' THEN 2
                    ELSE 3
                END,
                t.creado_en,
                t.id
        ) AS posicion,
        ROW_NUMBER() OVER (
            PARTITION BY t.periodo_operativo_id
            ORDER BY
                CASE t.prioridad
                    WHEN 'URGENTE'    THEN 1
                    WHEN 'PREFERENTE' THEN 2
                    ELSE 3
                END,
                t.creado_en,
                t.id
        ) AS posicion_global
    FROM turnos t
    WHERE t.estado = 'WAITING'
)
SELECT
    o.id                                 AS turno_id,
    o.codigo                             AS codigo_turno,
    o.folio,
    o.periodo_operativo_id,
    o.tramite_id,
    tr.clave                             AS clave_tramite,
    tr.denominacion                      AS denominacion_tramite,
    o.prioridad,
    o.posicion,
    o.posicion - 1                       AS personas_delante,
    o.posicion_global,
    o.creado_en,
    o.tiempo_estimado_mostrado_minutos,
    tr.tiempo_estimado_minutos,
    o.reclamado_en,
    o.aviso_programado_en,
    (o.aviso_programado_en IS NOT NULL) AS tiene_aviso_programado
FROM orden o
INNER JOIN tramites tr ON tr.id = o.tramite_id;

COMMENT ON VIEW vista_cola_espera IS
    'Cola de espera por periodo, con la posicion, el tiempo estimado y si el turno ya tiene aviso programado (mig 30).';

NOTIFY pgrst, 'reload schema';

COMMIT;
