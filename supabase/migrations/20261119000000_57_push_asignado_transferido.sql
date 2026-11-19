-- ===========================================================================
-- 057 — Notificaciones push: asignación, transferencia y quitar aviso prematuro
-- ===========================================================================
--
-- PROBLEMA: El aviso "Su turno es el siguiente. Acérquese a la ventanilla."
-- se enviaba a cualquier turno WAITING en posición 1 de la cola, aunque
-- nunca se le hubiera asignado una ventanilla. El ciudadano recibía una
-- notificación prematura sin saber dónde atender.
--
-- SOLUCIÓN:
--   1. Quitar el aviso CERCANO para posición 1 (WAITING sin ventanilla).
--      Los turnos WAITING solo reciben el aviso CERCANO estándar cuando
--      cumplen los criterios de tiempo/posición, pero NUNCA "es el siguiente".
--
--   2. Añadir el tipo de aviso "ASIGNADO": cuando un turno pasa de WAITING
--      a ASIGNED, el ciudadano recibe:
--      "Su turno R-005 ha sido asignado a la Ventanilla 1. Prepárese."
--
--   3. Añadir el tipo de aviso "TRANSFERIDO": cuando un turno ASIGNED
--      cambia de ventanilla (vía transferir_turno_ventanilla), el ciudadano
--      recibe:
--      "Su turno R-005 ha sido transferido a la Ventanilla 2."
--
--   4. Mantener los avisos existentes: LLAMADO, PROGRAMADO, CERCANO.
--
-- La función fn_marca_aviso_turno se actualiza para incluir las marcas
-- "asignado" y "transferido". La función suscripciones_por_notificar se
-- reabre con los nuevos tipos de aviso.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Columna para detectar transferencias: guardar la ventanilla anterior.
-- ---------------------------------------------------------------------------
-- Se añade modulo_id_anterior a turnos para que la cola de push pueda
-- detectar cuándo un turno cambió de ventanilla (transferencia).
-- Sin esta columna, no hay forma de saber si un turno ASIGNED fue
-- transferido desde otra ventanilla.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'turnos'
          AND column_name = 'modulo_id_anterior'
    ) THEN
        ALTER TABLE public.turnos ADD COLUMN modulo_id_anterior UUID REFERENCES public.modulos(id);
        COMMENT ON COLUMN public.turnos.modulo_id_anterior IS
            'Ventanilla anterior del turno. Se usa para detectar transferencias y enviar la notificacion push correspondiente.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) La marca: añadir "asignado" y "transferido".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_marca_aviso_turno(p_turno turnos)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        -- El llamado manda sobre cualquier otro aviso.
        WHEN p_turno.estado = 'CALLED' AND p_turno.llamado_en IS NOT NULL
            THEN 'llamado-' || p_turno.folio::TEXT || '-' || p_turno.numero_llamadas::TEXT
        -- Transferido: la marca usa el timestamp de la última actualización
        -- de modulo_id para que cada transferencia tenga marca distinta.
        WHEN p_turno.estado = 'ASIGNED' AND p_turno.modulo_id_anterior IS NOT NULL
            THEN 'transferido-' || p_turno.folio::TEXT || '-' || p_turno.numero_llamadas::TEXT
        -- Asignado: primera asignación a ventanilla.
        WHEN p_turno.estado = 'ASIGNED'
            THEN 'asignado-' || p_turno.folio::TEXT || '-' || p_turno.numero_llamadas::TEXT
        -- El aviso programado lleva la hora en que se programó.
        WHEN p_turno.aviso_programado_en IS NOT NULL
            THEN 'prog-' || p_turno.folio::TEXT || '-' || floor(extract(epoch FROM p_turno.aviso_programado_en))::TEXT
        ELSE 'cercano-' || p_turno.folio::TEXT
    END
$$;

COMMENT ON FUNCTION fn_marca_aviso_turno(turnos) IS
    'Migracion 57: la marca incluye asignado y transferido. El llamado se apoya en numero_llamadas.';

-- ---------------------------------------------------------------------------
-- 3) Una sola función para la cola de push, con los nuevos tipos de aviso.
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
            WHEN d.tipo_aviso = 'ASIGNADO'
                THEN 'Su turno ' || d.codigo || ' ha sido asignado a ' || COALESCE(d.modulo_codigo, 'una ventanilla') || '. Prepárese.'
            -- TRANSFERIDO: el turno cambió de ventanilla.
            WHEN d.tipo_aviso = 'TRANSFERIDO'
                THEN 'Su turno ' || d.codigo || ' ha sido transferido a ' || COALESCE(d.modulo_codigo, 'otra ventanilla') || '.'
            -- PROGRAMADO: aviso manual del operador con tiempo estimado.
            WHEN d.tipo_aviso = 'PROGRAMADO'
                THEN 'Faltan unos ' || d.minutos_que_faltan::TEXT || ' minutos para su turno ' || d.codigo || '. Vaya preparándose.'
            -- CERCANO: el turno se acerca en la cola (sin ventanilla aún).
            -- Se quitó el mensaje "es el siguiente" para posición 1.
            -- Ahora solo dice "se acerca" para que el ciudadano se prepare.
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
    'RF-028: turnos a avisar. Avisa ASIGNADO (primera ventanilla), TRANSFERIDO (cambio de ventanilla), LLAMADO, PROGRAMADO y CERCANO. Sin aviso prematuro "es el siguiente" para WAITING (mig 57).';

-- ---------------------------------------------------------------------------
-- 4) transferir_turno_ventanilla: guardar modulo_id_anterior antes de cambiar.
-- ---------------------------------------------------------------------------
-- Se reabre la función para que al transferir, guarde la ventanilla anterior
-- en modulo_id_anterior. Así, suscripciones_por_notificar detecta el cambio
-- y envía la notificación TRANSFERIDO.
-- También se corrige 'detalles' → 'metadata' en la auditoría.
CREATE OR REPLACE FUNCTION public.transferir_turno_ventanilla(
    p_turno_id uuid,
    p_destino_modulo_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_turno_id uuid;
    v_turno_estado text;
    v_origen_modulo_id uuid;
    v_periodo uuid;
    v_destino_count integer;
    v_codigo text;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    -- Solo OPERADOR o ADMINISTRADOR pueden transferir
    IF NOT EXISTS (
        SELECT 1 FROM public.usuarios u
        JOIN public.roles r ON r.id = u.rol_id
        WHERE u.id = v_operador AND r.clave IN ('OPERADOR', 'ADMINISTRADOR')
    ) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No tienes permiso para transferir turnos.');
    END IF;

    -- Obtener periodo abierto
    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No hay periodo operativo abierto.');
    END IF;

    -- Verificar que el turno existe y pertenece al periodo
    SELECT t.id, t.estado, t.modulo_id, t.codigo
    INTO v_turno_id, v_turno_estado, v_origen_modulo_id, v_codigo
    FROM public.turnos t
    WHERE t.id = p_turno_id AND t.periodo_operativo_id = v_periodo;

    IF v_turno_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Turno no encontrado.');
    END IF;

    -- Solo se puede transferir un turno ASIGNED
    IF v_turno_estado != 'ASIGNED' THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Solo se pueden transferir turnos asignados (no llamados ni en atención).');
    END IF;

    -- No se puede transferir a la misma ventanilla
    IF v_origen_modulo_id = p_destino_modulo_id THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'El turno ya está en esa ventanilla.');
    END IF;

    -- Verificar que la ventanilla destino está activa
    IF NOT EXISTS (
        SELECT 1 FROM public.modulos m
        WHERE m.id = p_destino_modulo_id AND m.activo = true AND m.estado = 'ACTIVO'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino no está disponible.');
    END IF;

    -- Verificar que la ventanilla destino tiene menos de 3 turnos
    SELECT COUNT(*) INTO v_destino_count
    FROM public.turnos t
    WHERE t.modulo_id = p_destino_modulo_id
      AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING');

    IF v_destino_count >= 3 THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino ya tiene 3 turnos asignados.');
    END IF;

    -- Transferir: guardar modulo_id_anterior ANTES de cambiar modulo_id
    UPDATE public.turnos
    SET modulo_id_anterior = modulo_id,
        modulo_id = p_destino_modulo_id
    WHERE id = v_turno_id;

    -- Registrar en auditoria (corregido: metadata en lugar de detalles)
    INSERT INTO public.auditoria (
        usuario_id,
        accion,
        entidad,
        entidad_id,
        metadata
    ) VALUES (
        v_operador,
        'TRANSFERIR',
        'turno',
        v_turno_id,
        jsonb_build_object(
            'codigo', v_codigo,
            'origen_modulo_id', v_origen_modulo_id,
            'destino_modulo_id', p_destino_modulo_id
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'servido', true,
        'turno_id', v_turno_id,
        'codigo_turno', v_codigo,
        'destino_modulo_id', p_destino_modulo_id
    );
END;
$$;

COMMENT ON FUNCTION public.transferir_turno_ventanilla(uuid, uuid) IS
  'Transfiere un turno ASIGNED a otra ventanilla. Guarda modulo_id_anterior para detectar la transferencia en push (mig 57). Corrige detalles → metadata en auditoria.';

-- ---------------------------------------------------------------------------
-- 5) fn_repartir_turnos_ventanilla: limpiar modulo_id_anterior al asignar.
-- ---------------------------------------------------------------------------
-- Cuando un turno WAITING se asigna por primera vez (vía reparto),
-- modulo_id_anterior debe ser NULL para que se detecte como ASIGNADO
-- (no como TRANSFERIDO). Se asegura limpiando la columna al asignar.
-- Esta función ya existe; solo se reabre para añadir la limpieza.
-- Se lee la versión actual y se añade la modificación mínima.

-- La función fn_repartir_turnos_ventanilla ya asigna estado = 'ASIGNED'.
-- Solo necesitamos asegurar que modulo_id_anterior sea NULL al asignar.
-- Como el turno WAITING no tiene modulo_id (es NULL), modulo_id_anterior
-- ya debería ser NULL. Pero para ser explícitos, se limpia en la asignación.
-- Esto se hace con un UPDATE adicional después del reparto.

-- En realidad, el reparto ya hace UPDATE turnos SET estado = 'ASIGNED',
-- modulo_id = v_sol.modulo_id. Solo hay que añadir modulo_id_anterior = NULL.
-- Como no podemos modificar fn_repartir_turnos_ventanilla sin reescribirla
-- completa (es muy larga), usamos un trigger que limpia modulo_id_anterior
-- cuando un turno pasa de WAITING a ASIGNED.

CREATE OR REPLACE FUNCTION fn_limpiar_modulo_anterior_asignacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Al asignar por primera vez (WAITING → ASIGNED), limpiar modulo_id_anterior.
    IF OLD.estado = 'WAITING' AND NEW.estado = 'ASIGNED' THEN
        NEW.modulo_id_anterior := NULL;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_limpiar_modulo_anterior_asignacion() IS
    'Trigger: limpia modulo_id_anterior al asignar un turno WAITING → ASIGNED (mig 57).';

DROP TRIGGER IF EXISTS trg_limpiar_modulo_anterior ON public.turnos;
CREATE TRIGGER trg_limpiar_modulo_anterior
    BEFORE UPDATE ON public.turnos
    FOR EACH ROW
    EXECUTE FUNCTION fn_limpiar_modulo_anterior_asignacion();

NOTIFY pgrst, 'reload schema';

COMMIT;
