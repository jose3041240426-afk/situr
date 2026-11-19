-- ===========================================================================
-- 058 — Restaurar transferencias_pendientes y corregir mensaje ASIGNADO
-- ===========================================================================
--
-- PROBLEMA 1: La migración 54 sobrescribió estado_ventanillas() sin incluir
-- transferencias_pendientes. La campana del rol AGENTE no recibía solicitudes
-- porque la RPC devolvía siempre un array vacío.
--
-- PROBLEMA 2: El mensaje de notificación ASIGNADO decía "Prepárese." y el
-- usuario quiere solo "Su turno X ha sido asignado a ventanilla N".
--
-- SOLUCIÓN:
--   1. Reabrir estado_ventanillas() con transferencias_pendientes (igual que
--      en la migración 49).
--   2. Corregir el mensaje ASIGNADO en suscripciones_por_notificar().
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) estado_ventanillas: restaurar transferencias_pendientes.
-- ---------------------------------------------------------------------------
-- Se reabre la función completa manteniendo los cambios de la mig 54 (FIFO
-- puro sin prioridad) y añadiendo transferencias_pendientes de la mig 49.
CREATE OR REPLACE FUNCTION public.estado_ventanillas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_periodo  uuid;
    v_cola     jsonb;
    v_vent     jsonb;
BEGIN
    v_operador := public.fn_usuario_actual();

    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'periodo_id', NULL, 'cola', '[]'::jsonb, 'ventanillas', '[]'::jsonb);
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(t))::jsonb, '[]'::jsonb) INTO v_cola
    FROM (
        SELECT t.id AS turno_id, t.codigo AS codigo_turno,
               tr.prefijo AS clave_tramite, tr.denominacion AS denominacion_tramite,
               t.estado AS estado,
               row_number() OVER (ORDER BY t.creado_en, t.id) AS posicion,
               row_number() OVER (ORDER BY t.creado_en, t.id) AS posicion_llegada,
               t.creado_en,
               m.codigo AS modulo_codigo
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        LEFT JOIN public.modulos m ON m.id = t.modulo_id
        WHERE t.periodo_operativo_id = v_periodo
          AND t.estado = 'WAITING'
    ) t;

    SELECT COALESCE(jsonb_agg(row_to_json(v))::jsonb, '[]'::jsonb) INTO v_vent
    FROM (
        SELECT
            m.id AS modulo_id,
            m.codigo,
            m.denominacion,
            m.estado AS estado_ventanilla,
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM public.turnos t2
                    WHERE t2.modulo_id = m.id AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                ) THEN 'ATENDIENDO'
                ELSE 'DISPONIBLE'
            END AS estado_con_turno,
            COALESCE((
                SELECT jsonb_agg(row_to_json(tt))
                FROM (
                    SELECT
                        t.id AS turno_id,
                        t.codigo AS turno_codigo,
                        t.estado AS turno_estado,
                        tr.denominacion AS turno_denominacion_tramite,
                        EXTRACT(EPOCH FROM (now() - t.llamado_en)) / 60 AS minutos_en_ventanilla,
                        u.nombres || ' ' || COALESCE(a_pat.apellido, '') || ' ' || COALESCE(a_mat.apellido, '') AS operador_nombres
                    FROM public.turnos t
                    JOIN public.tramites tr ON tr.id = t.tramite_id
                    LEFT JOIN public.usuarios u ON u.id = t.atendido_por
                    LEFT JOIN public.apellidos a_pat ON a_pat.id = u.apellido_paterno_id
                    LEFT JOIN public.apellidos a_mat ON a_mat.id = u.apellido_materno_id
                    WHERE t.modulo_id = m.id
                      AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                    ORDER BY t.creado_en
                    LIMIT 3
                ) tt
            ), '[]'::jsonb) AS turnos_asignados,
            (
                SELECT COUNT(*)
                FROM public.turnos t2
                WHERE t2.modulo_id = m.id
                  AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
            ) AS turno_count,
            (m.id IS NOT DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador)) AS es_mia,
            CASE
                WHEN NOT EXISTS (
                    SELECT 1 FROM public.turnos t2
                    WHERE t2.modulo_id = m.id AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                ) AND m.estado = 'ACTIVO' THEN true
                ELSE false
            END AS disponible,
            -- transferencias_pendientes: restaurado de mig 49 (perdido en mig 54)
            COALESCE((
                SELECT jsonb_agg(row_to_json(st))
                FROM (
                    SELECT st.id AS solicitud_id,
                           tu.codigo AS turno_codigo,
                           mo.codigo AS origen_codigo,
                           st.creado_en
                    FROM public.solicitudes_transferencia st
                    JOIN public.turnos tu ON tu.id = st.turno_id
                    JOIN public.modulos mo ON mo.id = st.origen_modulo_id
                    WHERE st.destino_modulo_id = m.id
                      AND st.estado = 'PENDIENTE'
                    ORDER BY st.creado_en
                ) st
            ), '[]'::jsonb) AS transferencias_pendientes
        FROM public.modulos m
        WHERE m.activo
        ORDER BY m.codigo
    ) v;

    RETURN jsonb_build_object(
        'ok', true,
        'periodo_id', v_periodo,
        'cola', v_cola,
        'ventanillas', v_vent
    );
END;
$$;

COMMENT ON FUNCTION public.estado_ventanillas() IS
    'Mig 58: restaura transferencias_pendientes (perdido en mig 54). FIFO puro sin prioridad.';

GRANT EXECUTE ON FUNCTION public.estado_ventanillas() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) suscripciones_por_notificar: corregir mensaje ASIGNADO.
-- ---------------------------------------------------------------------------
-- Cambiar "Su turno X ha sido asignado a V1. Prepárese." a
-- "Su turno X ha sido asignado a ventanilla N".
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
            t.modulo_id,
            t.modulo_id_anterior,
            s.endpoint,
            s.clave_p256dh,
            s.clave_auth,
            s.activa,
            s.ultima_activacion,
            s.ultimo_aviso_marca,
            m.codigo                                   AS modulo_codigo,
            v.posicion_global,
            v.personas_delante,
            -- Qué AVISO es este turno: prioridad de tipos.
            CASE
                WHEN t.estado = 'CALLED' AND t.llamado_en IS NOT NULL
                    THEN 'LLAMADO'
                WHEN t.estado = 'ASIGNED' AND t.modulo_id_anterior IS NOT NULL
                    THEN 'TRANSFERIDO'
                WHEN t.estado = 'ASIGNED'
                    THEN 'ASIGNADO'
                WHEN t.aviso_programado_en IS NOT NULL
                    THEN 'PROGRAMADO'
                ELSE 'CERCANO'
            END                                        AS tipo_aviso,
            -- Y la marca que lo identifica.
            CASE
                WHEN t.estado = 'CALLED' AND t.llamado_en IS NOT NULL
                    THEN 'llamado-' || t.folio::TEXT || '-' || t.numero_llamadas::TEXT
                WHEN t.estado = 'ASIGNED' AND t.modulo_id_anterior IS NOT NULL
                    THEN 'transferido-' || t.folio::TEXT || '-' || t.numero_llamadas::TEXT
                WHEN t.estado = 'ASIGNED'
                    THEN 'asignado-' || t.folio::TEXT || '-' || t.numero_llamadas::TEXT
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
          AND t.estado IN ('WAITING', 'ASIGNED', 'CALLED', 'SERVING')
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
            -- LLAMADO: el turno fue llamado a una ventanilla específica.
            WHEN d.tipo_aviso = 'LLAMADO'
                THEN 'Su turno ' || d.codigo || ' fue llamado. Acudase a ' || COALESCE(d.modulo_codigo, 'su modulo') || '.'
            -- ASIGNADO: el turno recibió su primera ventanilla.
            -- Mig 58: quitar "Prepárese." y usar "ventanilla N".
            WHEN d.tipo_aviso = 'ASIGNADO'
                THEN 'Su turno ' || d.codigo || ' ha sido asignado a ventanilla ' || COALESCE(d.modulo_codigo, 'una ventanilla') || '.'
            -- TRANSFERIDO: el turno cambió de ventanilla.
            WHEN d.tipo_aviso = 'TRANSFERIDO'
                THEN 'Su turno ' || d.codigo || ' ha sido transferido a ' || COALESCE(d.modulo_codigo, 'otra ventanilla') || '.'
            -- PROGRAMADO: aviso manual del operador con tiempo estimado.
            WHEN d.tipo_aviso = 'PROGRAMADO'
                THEN 'Faltan unos ' || d.minutos_que_faltan::TEXT || ' minutos para su turno ' || d.codigo || '. Vaya preparándose.'
            -- CERCANO: el turno se acerca en la cola (sin ventanilla aún).
            WHEN COALESCE(d.posicion_global, 999999) <= 1
                THEN 'Su turno ' || d.codigo || ' se acerca. Prepárese: será llamado pronto.'
            ELSE 'Usted es el siguiente en pasar. Prepárese: su turno ' || d.codigo || ' se acerca.'
        END,
        d.marca,
        CASE
            WHEN d.tipo_aviso = 'LLAMADO'
                THEN 'SITUR · Su turno fue llamado'
            WHEN d.tipo_aviso = 'ASIGNADO'
                THEN 'SITUR · Turno asignado'
            WHEN d.tipo_aviso = 'TRANSFERIDO'
                THEN 'SITUR · Turno transferido'
            WHEN d.tipo_aviso = 'PROGRAMADO'
                THEN 'SITUR · Vaya preparándose'
            ELSE 'SITUR · Su turno se acerca'
        END
    FROM con_datos d
    WHERE
        -- Un turno concreto pide su aviso: se entrega sí o sí.
        (p_turno_id IS NOT NULL)
        OR (
            d.ultimo_aviso_marca IS DISTINCT FROM d.marca
            AND (
                -- El aviso programado se entrega EN EL ACTO.
                (d.tipo_aviso = 'PROGRAMADO')
                -- Los avisos de asignación y transferencia salen al detectarse.
                OR (d.tipo_aviso = 'ASIGNADO')
                OR (d.tipo_aviso = 'TRANSFERIDO')
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
    'Mig 58: mensaje ASIGNADO corregido a "ventanilla N" sin "Prepárese". Incluye ASIGNADO, TRANSFERIDO, LLAMADO, PROGRAMADO y CERCANO.';

NOTIFY pgrst, 'reload schema';

COMMIT;
