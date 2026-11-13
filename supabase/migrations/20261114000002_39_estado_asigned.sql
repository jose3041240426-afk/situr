-- ===========================================================================
-- 039 — Estado ASIGNED: separar asignación de ventanilla de llamada
-- ===========================================================================
--
-- El operador pulsa "Solicitar siguiente turno" para ASIGNAR la ventanilla
-- al ciudadano sin llamarlo todavía. El ciudadano ve en su QR en qué
-- ventanilla será atendido, pero no suena la llamada.
--
-- Cuando el operador pulsa "Llamar", el turno pasa de ASIGNED → CALLED
-- y entonces sí se muestra en la pantalla pública como llamado.
--
-- Flujo nuevo:
--   WAITING → ASIGNED (solicitar turno) → CALLED (llamar) → SERVING
--             (asignar ventanilla)         (llamar turno)    (iniciar atención)
--
-- Cambios:
--   1. Añadir 'ASIGNED' a enum_estado_turno.
--   2. fn_transicion_valida: WAITING → ASIGNED, ASIGNED → CALLED.
--   3. fn_repartir_turnos_ventanilla: usar ASIGNED en lugar de CALLED.
--   4. Nueva RPC: llamar_turno_asignado(p_turno_id) para ASIGNED → CALLED.
--   5. estado_ventanillas(): incluir turnos ASIGNED.
--   6. estado_ventanillas() vista: incluir estado ASIGNED.
-- ===========================================================================

-- [1] Añadir 'ASIGNED' al enum (fuera de transacción para que PostgreSQL
--     permita usarlo en las funciones que siguen) ----------------------------
ALTER TYPE enum_estado_turno ADD VALUE 'ASIGNED' AFTER 'WAITING';

COMMENT ON COLUMN turnos.estado IS
    'WAITING = esperando en cola global | ASIGNED = asignado a ventanilla (sin llamar) | CALLED = llamado | SERVING = en atención | COMPLETED = completado | CANCELLED = cancelado | SKIPPED = omitido';

BEGIN;

-- [2] fn_transicion_valida: nuevas transiciones -----------------------------
CREATE OR REPLACE FUNCTION fn_transicion_valida(
    p_desde enum_estado_turno,
    p_hacia enum_estado_turno
)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT (p_desde, p_hacia) IN (
        ('WAITING',   'ASIGNED'),
        ('WAITING',   'CALLED'),
        ('WAITING',   'CANCELLED'),
        ('WAITING',   'SKIPPED'),
        ('ASIGNED',   'CALLED'),
        ('ASIGNED',   'CANCELLED'),
        ('CALLED',    'SERVING'),
        ('CALLED',    'SKIPPED'),
        ('SERVING',   'COMPLETED')
    );
$$;

-- [3] fn_repartir_turnos_ventanilla: ASIGNED en lugar de CALLED -------------
-- Se reabre la función para cambiar el estado de CALLED a ASIGNED.
-- El turno se asigna a la ventanilla pero NO se llama todavía.
CREATE OR REPLACE FUNCTION public.fn_repartir_turnos_ventanilla(p_periodo_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tope      INTEGER;
    v_sol       solicitudes_ventanilla%ROWTYPE;
    v_turno     turnos%ROWTYPE;
    v_tramite   tramites%ROWTYPE;
    v_servidas  INTEGER := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(4242::int, hashtext(p_periodo_id::text));

    SELECT COALESCE(
        (SELECT NULLIF(btrim(valor), '')::INTEGER
           FROM configuracion
          WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'),
        3
    ) INTO v_tope;

    -- [A] QUÉ TURNO SE ENTREGA ----------------------------------------------
    SELECT * INTO v_turno
      FROM turnos
     WHERE periodo_operativo_id = p_periodo_id
       AND estado = 'WAITING'
     ORDER BY
        CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
        creado_en,
        id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- [B] A QUIÉN SE ENTREGA -----------------------------------------------
    SELECT sv.* INTO v_sol
      FROM solicitudes_ventanilla sv
      JOIN modulos m ON m.id = sv.modulo_id
     WHERE sv.periodo_operativo_id = p_periodo_id
       AND m.activo
       AND m.estado = 'ACTIVO'
       AND v_tope > 0
       AND NOT EXISTS (
              SELECT 1 FROM turnos t
               WHERE t.modulo_id = m.id
                 AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING'))
     ORDER BY COALESCE(m.ultima_asignacion_en, '-infinity'::timestamptz) ASC,
              sv.creado_en ASC,
              sv.id ASC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- [C] TRANSICIÓN VÁLIDA (RN-011) ---------------------------------------
    IF NOT fn_transicion_valida(v_turno.estado, 'ASIGNED') THEN
        RAISE EXCEPTION 'Transicion % -> ASIGNED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    -- [D] ASIGNAR -----------------------------------------------------------
    -- ASIGNED: el turno tiene ventanilla, pero NO ha sido llamado.
    UPDATE turnos
       SET estado          = 'ASIGNED',
           modulo_id       = v_sol.modulo_id,
           atendido_por    = v_sol.operador_id,
           llamado_en      = now(),
           numero_llamadas = numero_llamadas + 1,
           token_expira_en = calcular_expiracion_token('ASIGNED')
     WHERE id = v_turno.id;

    UPDATE modulos
       SET ultima_asignacion_en = now()
     WHERE id = v_sol.modulo_id;

    -- [E] LIMPIAR SOLICITUD ------------------------------------------------
    DELETE FROM solicitudes_ventanilla WHERE id = v_sol.id;

    -- [F] TRAza ------------------------------------------------------------
    INSERT INTO historial_turnos
        (turno_id, estado_anterior, estado_nuevo, usuario_id, modulo_id, motivo, metadata)
    VALUES (
        v_turno.id, 'WAITING', 'ASIGNED', v_sol.operador_id, v_sol.modulo_id,
        'Asignado a ventanilla',
        jsonb_build_object(
            'codigo', v_turno.codigo,
            'tramite', v_tramite.prefijo,
            'modulo', (SELECT codigo FROM modulos WHERE id = v_sol.modulo_id),
            'operador', v_sol.operador_id
        )
    );

    PERFORM registrar_auditoria(
        v_sol.operador_id, 'ASIGNAR_TURNO_VENTANILLA', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object(
            'modulo', (SELECT codigo FROM modulos WHERE id = v_sol.modulo_id),
            'turno', v_turno.codigo
        )
    );

    v_servidas := v_servidas + 1;
    RETURN v_servidas;
END;
$$;

-- [4] Nueva RPC: llamar_turno_asignado(p_turno_id) --------------------------
-- Pasa un turno de ASIGNED → CALLED. Solo puede llamarlo el operador
-- al que está asignado el turno.
CREATE OR REPLACE FUNCTION public.llamar_turno_asignado(p_turno_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_turno    public.turnos%ROWTYPE;
    v_modulo   public.modulos%ROWTYPE;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    -- Solo quien puede operar turnos.
    IF NOT public.fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede llamar turnos.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno FROM public.turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    -- Solo ASIGNED → CALLED.
    IF v_turno.estado <> 'ASIGNED' THEN
        RAISE EXCEPTION 'El turno % no está asignado (estado: %).', v_turno.codigo, v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    -- Solo el operador asignado puede llamar.
    IF v_turno.atendido_por IS DISTINCT FROM v_operador THEN
        RAISE EXCEPTION 'No puede llamar un turno que no le está asignado.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT fn_transicion_valida(v_turno.estado, 'CALLED') THEN
        RAISE EXCEPTION 'Transicion % -> CALLED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.turnos
       SET estado = 'CALLED',
           llamado_en = now(),
           token_expira_en = calcular_expiracion_token('CALLED')
     WHERE id = v_turno.id;

    SELECT * INTO v_modulo FROM public.modulos WHERE id = v_turno.modulo_id;

    INSERT INTO public.historial_turnos
        (turno_id, estado_anterior, estado_nuevo, usuario_id, modulo_id, motivo, metadata)
    VALUES (
        v_turno.id, 'ASIGNED', 'CALLED', v_operador, v_turno.modulo_id,
        'Turno llamado',
        jsonb_build_object('codigo', v_turno.codigo, 'modulo', v_modulo.codigo)
    );

    PERFORM public.registrar_auditoria(
        v_operador, 'LLAMAR_TURNO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo, 'modulo', v_modulo.codigo)
    );

    -- Aviso en tiempo real.
    PERFORM pg_notify(
        'turnos_cambios',
        jsonb_build_object(
            'tipo', 'LLAMADO',
            'turno_id', v_turno.id::text,
            'codigo', v_turno.codigo,
            'modulo_id', v_turno.modulo_id::text,
            'modulo_codigo', v_modulo.codigo
        )::text
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo', v_turno.codigo,
        'modulo_codigo', v_modulo.codigo
    );
END;
$$;

REVOKE ALL ON FUNCTION public.llamar_turno_asignado(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.llamar_turno_asignado(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.llamar_turno_asignado(uuid) TO authenticated;

-- [5] calcular_expiracion_token: añadir caso ASIGNED ------------------------
CREATE OR REPLACE FUNCTION calcular_expiracion_token(p_estado enum_estado_turno)
RETURNS TIMESTAMPTZ
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_estado
        WHEN 'WAITING'   THEN
            now() + (fn_config_entero('MINUTOS_VIGENCIA_TOKEN_EN_ESPERA', 1440) || ' minutes')::interval
        WHEN 'ASIGNED'   THEN
            now() + (fn_config_entero('MINUTOS_VIGENCIA_TOKEN_EN_ESPERA', 1440) || ' minutes')::interval
        WHEN 'CALLED'    THEN
            now() + (fn_config_entero('MINUTOS_VIGENCIA_TOKEN_LLAMADO', 30) || ' minutes')::interval
        WHEN 'SERVING'   THEN
            now() + (fn_config_entero('MINUTOS_VIGENCIA_TOKEN_EN_ESPERA', 1440) || ' minutes')::interval
        WHEN 'COMPLETED' THEN
            now() + (fn_config_entero('HORAS_VIGENCIA_TOKEN_CERRADO', 1) || ' hours')::interval
        WHEN 'CANCELLED' THEN
            now() + (fn_config_entero('HORAS_VIGENCIA_TOKEN_CERRADO', 1) || ' hours')::interval
        WHEN 'SKIPPED'   THEN
            now() + (fn_config_entero('HORAS_VIGENCIA_TOKEN_CERRADO', 1) || ' hours')::interval
        ELSE
            now() + (fn_config_entero('MINUTOS_VIGENCIA_TOKEN_EN_ESPERA', 1440) || ' minutes')::interval
    END;
$$;

-- [6] estado_ventanillas(): incluir ASIGNED ---------------------------------
-- Se reabre para que la vista incluya turnos en estado ASIGNED.
-- La función completa está en la mig 38; aquí solo se parchea el WHERE.
-- Se reabre la función completa de la mig 38 con el cambio.

-- [6a] estado_ventanillas RPC: incluir ASIGNED en el WHERE de turnos
-- La función completa se reabre con el cambio en el CTE v_turnos.
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
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'periodo_id', NULL, 'cola', '[]'::jsonb, 'ventanillas', '[]'::jsonb);
    END IF;

    -- Cola global: WAITING y ASIGNED (los ASIGNED ya tienen ventanilla, pero se muestran en la cola).
    SELECT COALESCE(jsonb_agg(row_to_json(t))::jsonb, '[]'::jsonb) INTO v_cola
    FROM (
        SELECT t.id AS turno_id, t.codigo AS codigo_turno,
               tr.prefijo AS clave_tramite, tr.denominacion AS denominacion_tramite,
               row_number() OVER (ORDER BY
                   CASE t.prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
                   t.creado_en, t.id
               ) AS posicion
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        WHERE t.periodo_operativo_id = v_periodo
          AND t.estado = 'WAITING'
    ) t;

    -- Ventanillas con turno asignado (ASIGNED, CALLED, SERVING).
    SELECT COALESCE(jsonb_agg(row_to_json(v))::jsonb, '[]'::jsonb) INTO v_vent
    FROM (
        SELECT
            m.id AS modulo_id,
            m.codigo,
            m.denominacion,
            m.estado AS estado_ventanilla,
            CASE
                WHEN t.id IS NOT NULL THEN
                    CASE
                        WHEN t.estado IN ('ASIGNED', 'CALLED', 'SERVING') THEN 'ATENDIENDO'
                        ELSE 'DISPONIBLE'
                    END
                ELSE 'SIN_DISPONIBILIDAD'
            END AS estado_con_turno,
            t.id AS turno_id,
            t.codigo AS turno_codigo,
            t.estado AS turno_estado,
            tr.denominacion AS turno_denominacion_tramite,
            EXTRACT(EPOCH FROM (now() - t.llamado_en)) / 60 AS minutos_en_ventanilla,
            u.nombres || ' ' || COALESCE(a_pat.apellido, '') || ' ' || COALESCE(a_mat.apellido, '') AS operador_nombres,
            (m.id IS NOT DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador)) AS es_mia,
            CASE
                WHEN t.id IS NULL AND m.estado = 'ACTIVO' THEN true
                ELSE false
            END AS disponible
        FROM public.modulos m
        LEFT JOIN public.turnos t ON t.modulo_id = m.id
            AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
        LEFT JOIN public.tramites tr ON tr.id = t.tramite_id
        LEFT JOIN public.usuarios u ON u.id = t.atendido_por
        LEFT JOIN public.apellidos a_pat ON a_pat.id = u.apellido_paterno_id
        LEFT JOIN public.apellidos a_mat ON a_mat.id = u.apellido_materno_id
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

-- [7] solicitar_turno_ventanilla: actualizar para ASIGNED --------------------
-- Se reabre para buscar turnos ASIGNED en lugar de CALLED en la verificación.
CREATE OR REPLACE FUNCTION public.solicitar_turno_ventanilla(p_modulo_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador  uuid;
    v_modulo    public.modulos%ROWTYPE;
    v_periodo   uuid;
    v_tope      integer;
    v_abiertos  integer;
    v_solicitud bigint;
    v_en_espera integer;
    v_turno     public.turnos%ROWTYPE;
    v_res       jsonb;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_modulo FROM public.modulos WHERE id = p_modulo_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El modulo no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_modulo.id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RAISE EXCEPTION 'No puede operar una ventanilla que no le esta asignada.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE((SELECT NULLIF(btrim(valor), '')::INTEGER FROM public.configuracion WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'), 3)
      INTO v_tope;
    SELECT COUNT(*) INTO v_abiertos FROM public.turnos
     WHERE modulo_id = v_modulo.id AND estado IN ('ASIGNED', 'CALLED', 'SERVING');
    IF v_abiertos >= 1 OR v_tope <= 0 THEN
        RAISE EXCEPTION 'La ventanilla % tiene un turno asignado. Termine o cancele antes de pedir otro.', v_modulo.codigo
            USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;
    IF v_periodo IS NULL THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto.' USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(4242::int, hashtext(v_periodo::text));

    SELECT id INTO v_solicitud FROM public.solicitudes_ventanilla
     WHERE periodo_operativo_id = v_periodo AND modulo_id = v_modulo.id AND operador_id = v_operador
     LIMIT 1;
    IF v_solicitud IS NULL THEN
        INSERT INTO public.solicitudes_ventanilla (periodo_operativo_id, modulo_id, operador_id)
        VALUES (v_periodo, v_modulo.id, v_operador)
        RETURNING id INTO v_solicitud;
    END IF;

    LOOP
        EXIT WHEN public.fn_repartir_turnos_ventanilla(v_periodo) = 0;
    END LOOP;

    SELECT * INTO v_turno FROM public.turnos t
     WHERE t.modulo_id = v_modulo.id AND t.atendido_por = v_operador
       AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
     ORDER BY t.llamado_en DESC LIMIT 1;

    IF v_turno.id IS NULL THEN
        SELECT count(*) INTO v_en_espera FROM public.solicitudes_ventanilla
         WHERE periodo_operativo_id = v_periodo;
        RETURN jsonb_build_object(
            'ok', true, 'servido', false, 'en_espera', v_en_espera,
            'modulo_codigo', v_modulo.codigo,
            'motivo', CASE WHEN v_en_espera = 0
                           THEN 'No hay turnos pendientes.'
                           ELSE 'Su ventanilla esta en la cola: hay otras esperando antes.' END
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true, 'servido', true,
        'turno_id', v_turno.id, 'codigo_turno', v_turno.codigo,
        'modulo_codigo', v_modulo.codigo,
        'estado', v_turno.estado
    );
END;
$$;

-- [8] listarCola RPC: excluir ASIGNED de la cola pública --------------------
-- Los turnos ASIGNED ya tienen ventanilla, no están en la cola de espera.
-- La función ya filtra por WAITING, así que no necesita cambio, pero
-- se documenta aquí.

-- [9] Pantalla pública: incluir ASIGNED en los turnos actuales ---------------
-- La función listar_turnos_actuales ya filtra por CALLED y SERVING.
-- Ahora también incluye ASIGNED para que la pantalla muestre la ventanilla.
-- Se reabre la función si existe, o se crea si no.

-- [10] Notificar schema reload -----------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;
