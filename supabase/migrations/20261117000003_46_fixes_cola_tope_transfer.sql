-- ============================================================================
-- Migración 46 — Fixes: tope 3 en solicitar, cola solo WAITING, transfer AGENTE
-- ============================================================================
-- 1. solicitar_turno_ventanilla: tope = MAXIMO_TURNOS_EN_ATENCION (3) contando
--    ASIGNED+CALLED+SERVING (no rechazar tras el primero).
-- 2. estado_ventanillas: la cola solo muestra WAITING (los ASIGNED ya están
--    en sus contenedores de ventanilla).
-- 3. cola_en_vivo: solo WAITING.
-- 4. transferir_turno_ventanilla: permitir rol AGENTE.
-- ============================================================================
BEGIN;

-- 1. solicitar_turno_ventanilla
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
     WHERE modulo_id = v_modulo.id AND estado IN ('ASIGNED','CALLED','SERVING');
    IF v_abiertos >= v_tope OR v_tope <= 0 THEN
        RAISE EXCEPTION 'La ventanilla % ya tiene % turnos asignados (maximo %).', v_modulo.codigo, v_abiertos, v_tope
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
       AND t.estado IN ('ASIGNED','CALLED','SERVING')
     ORDER BY t.creado_en DESC LIMIT 1;

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
        'modulo_codigo', v_modulo.codigo
    );
END;
$$;

-- 2. estado_ventanillas: cola solo WAITING (los ASIGNED ya estan en contenedores)
-- (reusar mig 45 pero cola WAITING)
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
               t.prioridad,
               row_number() OVER (ORDER BY
                   CASE t.prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
                   t.creado_en, t.id
               ) AS posicion,
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
            END AS disponible
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

-- 3. cola_en_vivo: solo WAITING
CREATE OR REPLACE FUNCTION public.cola_en_vivo(p_limite integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo UUID;
    v_total   INTEGER;
    v_filas   JSONB;
BEGIN
    IF NOT (public.fn_puede_operar_turnos() OR public.fn_es_recepcion()) THEN
        RAISE EXCEPTION 'No tiene permiso para ver la cola en vivo.'
            USING ERRCODE = '42501';
    END IF;

    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object(
            'ok',        true,
            'periodo',   NULL,
            'total',     0,
            'filas',     '[]'::jsonb
        );
    END IF;

    SELECT count(*) INTO v_total
      FROM turnos
     WHERE estado = 'WAITING'
       AND periodo_operativo_id = v_periodo;

    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_filas
      FROM (
        SELECT jsonb_build_object(
            'turno_id',            t.id,
            'codigo_turno',        t.codigo,
            'folio',               t.folio,
            'clave_tramite',       tr.clave,
            'denominacion_tramite', tr.denominacion,
            'prioridad',           t.prioridad,
            'posicion_llegada',    row_number() OVER (ORDER BY t.creado_en, t.id),
            'posicion_global',     row_number() OVER (
                                    ORDER BY CASE t.prioridad
                                                WHEN 'URGENTE' THEN 1
                                                WHEN 'PREFERENTE' THEN 2
                                                ELSE 3 END,
                                             t.creado_en, t.id),
            'creado_en',           t.creado_en,
            'modulo_codigo',       m.codigo
        ) AS fila
        FROM turnos t
        JOIN tramites tr ON tr.id = t.tramite_id
        LEFT JOIN modulos m ON m.id = t.modulo_id
        WHERE t.estado = 'WAITING'
          AND t.periodo_operativo_id = v_periodo
        ORDER BY t.creado_en, t.id
        LIMIT greatest(coalesce(p_limite, 10), 0)
      ) s;

    RETURN jsonb_build_object(
        'ok',      true,
        'periodo', v_periodo,
        'total',   v_total,
        'filas',   v_filas
    );
END;
$$;

-- 4. transferir: permitir AGENTE
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
    v_rol text;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT r.clave INTO v_rol FROM public.roles r JOIN public.usuarios u ON u.rol_id = r.id WHERE u.id = v_operador;
    IF v_rol NOT IN ('AGENTE','ADMINISTRADOR','SUPERVISOR') THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No tienes permiso para transferir turnos.');
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No hay periodo operativo abierto.');
    END IF;

    SELECT t.id, t.estado, t.modulo_id, t.codigo
    INTO v_turno_id, v_turno_estado, v_origen_modulo_id, v_codigo
    FROM public.turnos t
    WHERE t.id = p_turno_id AND t.periodo_operativo_id = v_periodo;

    IF v_turno_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Turno no encontrado.');
    END IF;

    IF v_turno_estado != 'ASIGNED' THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Solo se pueden transferir turnos asignados (no llamados ni en atención).');
    END IF;

    IF v_origen_modulo_id = p_destino_modulo_id THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'El turno ya está en esa ventanilla.');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.modulos m
        WHERE m.id = p_destino_modulo_id AND m.activo = true
    ) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino no está activa.');
    END IF;

    SELECT COUNT(*) INTO v_destino_count
    FROM public.turnos t
    WHERE t.modulo_id = p_destino_modulo_id
      AND t.estado IN ('ASIGNED','CALLED','SERVING');
    IF v_destino_count >= 3 THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino ya tiene 3 turnos.');
    END IF;

    -- Solo el propietario (o admin) puede transferir
    IF v_rol = 'AGENTE' AND v_origen_modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No puede transferir un turno de otra ventanilla.');
    END IF;

    UPDATE public.turnos
       SET modulo_id = p_destino_modulo_id,
           atendido_por = (SELECT id FROM public.usuarios WHERE modulo_id = p_destino_modulo_id LIMIT 1)
     WHERE id = p_turno_id;

    PERFORM public.registrar_auditoria(
        v_operador, 'TRANSFERIR_TURNO', 'turnos', p_turno_id::text, 'EXITO',
        jsonb_build_object('codigo', v_codigo, 'destino', (SELECT codigo FROM public.modulos WHERE id = p_destino_modulo_id))
    );

    RETURN jsonb_build_object('ok', true, 'motivo', 'Turno transferido.');
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
