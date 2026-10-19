-- ============================================================================
-- SITUR — MIGRACIÓN 003: VISTAS
-- Modelo de datos FUSIONADO v2.0
--
-- Las 5 vistas vienen de TOMA_TURNO y se adaptan al modelo SITUR. Aportan la
-- capa de lectura que el DRS describía pero no entregaba.
--
-- Cambios respecto al original de TOMA_TURNO:
--  * posicion calculada por RN-014 (trámite + periodo) con el orden de
--    RN-017 (URGENTE > PREFERENTE > NORMAL, desempate creado_en, id).
--  * la fecha plana se sustituye por periodo_operativo_id (RG-002).
--  * vista_seguimiento_turnos YA NO se esfuma cuando el token expira (bug de
--    TOMA_TURNO: filtraba `tokens_turno.estado = 'ACTIVO'`; al vencerse el
--    token el ciudadano dejaba de ver su propio turno).
--  * solo el rol autenticado tiene SELECT sobre estas vistas; el ciudadano
--    pasa por get_turno_publico(), que devuelve 5 campos mínimos (RF-019).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- VISTA 1: COLA DE ESPERA
-- Quién sigue esperando y cuántas personas tiene delante.
-- Sustituye a `vista_cola_espera` de TOMA_TURNO.
-- ---------------------------------------------------------------------------
CREATE VIEW vista_cola_espera AS
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
        -- Orden GLOBAL de llamada: el MISMO ORDER BY que usa
        -- `llamar_siguiente_turno()`. Sin esta columna, el operador veía tres
        -- turnos con "posición 1" (uno por trámite) y no podía anticipar a
        -- quién iba a ser llamado: RN-014 (lo que ve el ciudadano) y RN-017
        -- (el orden real de llamada) son dos cosas distintas, y el panel tiene
        -- que mostrar las dos.
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
    -- RN-014 / RF-018: cuántas personas hay delante = posición menos uno.
    o.posicion - 1                       AS personas_delante,
    o.posicion_global,
    o.creado_en,
    o.tiempo_estimado_mostrado_minutos,
    tr.tiempo_estimado_minutos
FROM orden o
INNER JOIN tramites tr ON tr.id = o.tramite_id;

COMMENT ON VIEW vista_cola_espera IS
    'Turnos en espera con su posicion por tramite+periodo (RN-014) y orden de prioridad (RN-017).';

-- ---------------------------------------------------------------------------
-- VISTA 1 bis: TURNOS RETIRADOS POR EL TITULAR (RF-033)
--
-- Cuando el titular se opone al tratamiento, el turno se CANCELA: el
-- derecho a oponerse exige cesar, no outright esperar. Por eso **no está
-- en la cola de espera** (esa vista solo trae los `WAITING`), y sin esta
-- vista el operador se quedaba sin ningún rastro: el turno desaparecía
-- de la pantalla y nadie sabía si el ciudadano se había retirado o si el
-- sistema lo había perdido.
--
-- Aquí está el rastro, con lo que el titular escribió. No es un turno en
-- espera (no tiene posición ni se puede llamar): es un turno que ya no
-- va a ser atendido, y que el operador tiene que ver para no llamarlo.
-- ---------------------------------------------------------------------------
CREATE VIEW vista_turnos_retirados AS
SELECT
    t.id                       AS turno_id,
    t.codigo                   AS codigo_turno,
    t.folio,
    t.prioridad,
    t.tramite_id,
    tr.clave                   AS clave_tramite,
    tr.denominacion            AS denominacion_tramite,
    t.modulo_id,
    m.codigo                   AS codigo_modulo,
    m.denominacion             AS denominacion_modulo,
    t.consideraciones          AS consideracion,
    t.cancelado_en             AS retirado_en,
    t.periodo_operativo_id
FROM turnos t
INNER JOIN tramites tr ON tr.id = t.tramite_id
LEFT  JOIN modulos  m  ON m.id  = t.modulo_id
WHERE t.consideraciones IS NOT NULL
  AND t.estado = 'CANCELLED'
  AND t.cancelado_por IS NULL;

COMMENT ON VIEW vista_turnos_retirados IS
    'Turnos que el titular retiro oponiendose al tratamiento (RF-033). No son turnos en espera: no se pueden llamar. El operador los ve para saber que el ciudadano se retiro.';

-- ---------------------------------------------------------------------------
-- VISTA 2: TURNOS EN CURSO
-- Qué se está atendiendo ahora, en qué módulo y por quién.
-- Sustituye a `vista_turnos_actuales` de TOMA_TURNO.
-- ---------------------------------------------------------------------------
CREATE VIEW vista_turnos_actuales AS
SELECT
    t.id                        AS turno_id,
    t.codigo                    AS codigo_turno,
    t.folio,
    t.estado,
    t.prioridad,
    t.creado_en,
    t.llamado_en,
    t.inicio_atencion,
    t.numero_llamadas,
    t.periodo_operativo_id,
    t.tramite_id,
    tr.clave                    AS clave_tramite,
    tr.denominacion             AS denominacion_tramite,
    t.modulo_id,
    m.codigo                    AS codigo_modulo,
    m.denominacion              AS denominacion_modulo,
    u.id                        AS trabajador_id,
    btrim(
        CONCAT(
            u.nombres, ' ',
            a_pat.apellido, ' ',
            COALESCE(a_mat.apellido, '')
        )
    )                           AS nombre_trabajador,
    u.numero_empleado
FROM turnos t
INNER JOIN tramites tr        ON tr.id = t.tramite_id
LEFT JOIN modulos m           ON m.id  = t.modulo_id
LEFT JOIN usuarios u          ON u.id  = t.atendido_por
LEFT JOIN apellidos a_pat     ON a_pat.id = u.apellido_paterno_id
LEFT JOIN apellidos a_mat     ON a_mat.id = u.apellido_materno_id
WHERE t.estado IN ('CALLED', 'SERVING');

COMMENT ON VIEW vista_turnos_actuales IS
    'Turnos llamados o en atencion, con modulo y trabajador responsable.';

-- ---------------------------------------------------------------------------
-- VISTA 3: SEGUIMIENTO CIUDADANO
-- Sustituye a `vista_seguimiento_turnos` de TOMA_TURNO.
--
-- CORRECCIÓN DEL BUG: el original hacía
--     INNER JOIN tokens_turno tt ... WHERE tt.estado = 'ACTIVO'
-- de modo que, al vencerse el token, el ciudadano dejaba de ver su propio
-- turno y la consulta pública devolvía vacío. Aquí el turno siempre está en
-- la vista; quien decide si responde es get_turno_publico() (RF-019),
-- evaluando token_expira_en según el ciclo del DRS §9.
--
-- `security_invoker = true` (corrección de seguridad, 19-oct-2026):
-- sin esta opción la vista se ejecutaba con los privilegios de su propietario
-- y **se saltaba la RLS de `turnos`**. Como `authenticated` tiene SELECT
-- sobre la vista, cualquier cuenta iniciada —no solo el administrador—
-- podía leer `token_publico` de TODOS los turnos: el token es la única
-- credencial del ciudadano (RF-017), así que eso era una vía de suplantación.
-- Con `security_invoker` la vista se evalúa con los privilegios de quien
-- consulta, y la política `p_admin_turnos` (admin) la cierra. El
-- administrador conserva el acceso porque necesita el token para REIMPRIMIR
-- el QR (RF-007) — y nada más que ese rol lo ve.
-- ---------------------------------------------------------------------------
CREATE VIEW vista_seguimiento_turnos WITH (security_invoker = true) AS
SELECT
    t.id                                            AS turno_id,
    t.codigo                                        AS codigo_turno,
    t.folio,
    t.estado,
    t.prioridad,
    t.periodo_operativo_id,
    t.tramite_id,
    tr.clave                                        AS clave_tramite,
    tr.denominacion                                 AS denominacion_tramite,
    tr.tiempo_estimado_minutos,
    t.tiempo_estimado_mostrado_minutos,
    t.creado_en,
    t.llamado_en,
    t.inicio_atencion,
    t.finalizado_en,
    t.token_publico,
    t.token_expira_en,
    t.token_ultimo_acceso,
    m.codigo                                        AS codigo_modulo,
    m.denominacion                                  AS denominacion_modulo,
    -- RF-018: cuántas personas hay delante, dentro de su trámite+periodo.
    -- Solo tiene sentido si el turno sigue en espera; los demás estados
    -- devuelven 0 para no mostrar una posición falsa en el QR.
    CASE WHEN t.estado <> 'WAITING' THEN 0 ELSE (
        SELECT COUNT(*)
        FROM turnos t2
        WHERE t2.periodo_operativo_id = t.periodo_operativo_id
          AND t2.tramite_id           = t.tramite_id
          AND t2.estado               = 'WAITING'
          AND (
                CASE t2.prioridad
                    WHEN 'URGENTE'    THEN 1
                    WHEN 'PREFERENTE' THEN 2
                    ELSE 3
                END
                <
                CASE t.prioridad
                    WHEN 'URGENTE'    THEN 1
                    WHEN 'PREFERENTE' THEN 2
                    ELSE 3
                END
                OR (
                    CASE t2.prioridad
                        WHEN 'URGENTE'    THEN 1
                        WHEN 'PREFERENTE' THEN 2
                        ELSE 3
                    END
                    =
                    CASE t.prioridad
                        WHEN 'URGENTE'    THEN 1
                        WHEN 'PREFERENTE' THEN 2
                        ELSE 3
                    END
                    AND (t2.creado_en, t2.id) < (t.creado_en, t.id)
                )
          )
    ) END                                           AS personas_delante
FROM turnos t
INNER JOIN tramites tr ON tr.id = t.tramite_id
LEFT JOIN modulos m    ON m.id  = t.modulo_id;

COMMENT ON VIEW vista_seguimiento_turnos IS
    'Seguimiento de un turno por su token. A diferencia de TOMA_TURNO, no desaparece cuando el token vence: get_turno_publico() es quien aplica la vigencia.';

-- ---------------------------------------------------------------------------
-- VISTA 4: HISTORIAL COMPLETO
-- Sustituye a `vista_historial_turnos` de TOMA_TURNO; añade los motivos de
-- salto/cancelación que TOMA_TURNO no exponía.
-- ---------------------------------------------------------------------------
CREATE VIEW vista_historial_turnos AS
SELECT
    h.id                                    AS historial_id,
    h.turno_id,
    t.codigo                                AS codigo_turno,
    t.folio,
    tr.clave                                AS clave_tramite,
    tr.denominacion                         AS denominacion_tramite,
    h.estado_anterior,
    h.estado_nuevo,
    -- Estado ACTUAL del turno, no el de esta transición. Sin esta columna no
    -- había forma de saber, desde el historial, si un turno omitido o cancelado
    -- seguía siendo reclamable (la reposición) o ya se había resuelto.
    t.estado                             AS estado_actual,
    h.fecha,
    h.motivo,
    h.metadata,
    u.id                                    AS usuario_id,
    btrim(
        CONCAT(
            u.nombres, ' ',
            a_pat.apellido, ' ',
            COALESCE(a_mat.apellido, '')
        )
    )                                       AS nombre_usuario,
    u.numero_empleado,
    r.clave                                 AS clave_rol,
    r.nombre                                AS nombre_rol,
    m.codigo                                AS codigo_modulo,
    m.denominacion                          AS denominacion_modulo
FROM historial_turnos h
INNER JOIN turnos t        ON t.id  = h.turno_id
INNER JOIN tramites tr     ON tr.id = t.tramite_id
LEFT JOIN usuarios u       ON u.id  = h.usuario_id
LEFT JOIN apellidos a_pat  ON a_pat.id = u.apellido_paterno_id
LEFT JOIN apellidos a_mat  ON a_mat.id = u.apellido_materno_id
LEFT JOIN roles r          ON r.id  = u.rol_id
LEFT JOIN modulos m        ON m.id  = h.modulo_id;

COMMENT ON VIEW vista_historial_turnos IS
    'Historial de transiciones con trámite, rol, módulo y motivo.';

-- ---------------------------------------------------------------------------
-- VISTA 5: ESTADÍSTICAS POR TRÁMITE Y PERÍODO
-- Sustituye a `vista_estadisticas_servicios` de TOMA_TURNO.
-- El DRS (RF-022) pide desglose por trámite / módulo / periodo; TOMA_TURNO
-- solo agregaba por servicio y no separaba jornadas.
-- ---------------------------------------------------------------------------
CREATE VIEW vista_estadisticas_tramites AS
SELECT
    p.id                                        AS periodo_operativo_id,
    p.clave                                     AS fecha_periodo,
    t.tramite_id,
    tr.clave                                    AS clave_tramite,
    tr.denominacion                             AS denominacion_tramite,

    COUNT(*)                                    AS turnos_generados,

    COUNT(*) FILTER (WHERE t.estado = 'COMPLETED') AS turnos_atendidos,
    COUNT(*) FILTER (WHERE t.estado = 'CANCELLED') AS turnos_cancelados,
    COUNT(*) FILTER (WHERE t.estado = 'SKIPPED')   AS turnos_omitidos,
    COUNT(*) FILTER (WHERE t.estado = 'WAITING')   AS turnos_sin_atender,

    -- RF-022: tiempo promedio de espera (emisión -> inicio de atención).
    AVG(
        CASE WHEN t.creado_en IS NOT NULL AND t.inicio_atencion IS NOT NULL
             THEN EXTRACT(EPOCH FROM (t.inicio_atencion - t.creado_en)) / 60.0
        END
    )::numeric(10,2)                            AS espera_promedio_minutos,

    -- RF-022: tiempo promedio de atención (inicio -> finalización).
    AVG(
        CASE WHEN t.inicio_atencion IS NOT NULL AND t.finalizado_en IS NOT NULL
             THEN EXTRACT(EPOCH FROM (t.finalizado_en - t.inicio_atencion)) / 60.0
        END
    )::numeric(10,2)                            AS atencion_promedio_minutos,

    -- RF-011 / RF-013: cuántas veces hubo que repetir la llamada.
    SUM(t.numero_llamadas)                      AS total_llamadas_repetidas,

    tr.tiempo_estimado_minutos                  AS tiempo_estimado_minutos
FROM turnos t
INNER JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
INNER JOIN tramites tr           ON tr.id = t.tramite_id
GROUP BY
    p.id, p.clave,
    t.tramite_id, tr.clave, tr.denominacion,
    tr.tiempo_estimado_minutos;

COMMENT ON VIEW vista_estadisticas_tramites IS
    'Generados, atendidos, cancelados y omitidos por tramite y periodo, con tiempos promedio (RF-022).';
