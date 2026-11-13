-- ============================================================================
-- Migración 38 — Ventanillas con código V# y propiedad por operador (mig 38)
-- ============================================================================
-- 1. Los códigos de módulo pasan de "M01, M02, ..." a "V1, V2, ..." y la
--    restricción chk_modulos_codigo se relaja para aceptarlos.
-- 2. `estado_ventanillas()` añade `es_mia`: solo la ventanilla asignada al
--    operador que pregunta puede ser operada por él.
-- 3. `solicitar_turno_ventanilla()` rechaza operar una ventanilla que no es la
--    del operador (defensa en servidor, no solo en la interfaz).
-- 4. `iniciar_atencion_turno`, `finalizar_turno` y `cancelar_turno` rechazan
--    tocar un turno cuya ventanilla no es la del operador cuando éste es AGENTE.
--    Administradores y supervisores siguen pudiendo operar cualquiera.
-- ============================================================================

-- [1] Restricción de código --------------------------------------------------
ALTER TABLE public.modulos DROP CONSTRAINT IF EXISTS chk_modulos_codigo;
ALTER TABLE public.modulos
    ADD CONSTRAINT chk_modulos_codigo
    CHECK (codigo ~ '^V[0-9]{1,3}$' OR codigo ~ '^M[0-9]{2,3}$');

-- [2] Renombrado M01..M04 -> V1..V4 (solo los que existan) ------------------
UPDATE public.modulos SET codigo = 'V' || (substring(codigo from 2)::int)::text
 WHERE codigo ~ '^M[0-9]{2,3}$';

-- [3] estado_ventanillas(): añadir es_mia ------------------------------------
-- Se reemplaza la función completa para incluir el campo. El cuerpo es el mismo
-- que en la migración 37, con la línea nueva en el jsonb_build_object.
CREATE OR REPLACE FUNCTION public.estado_ventanillas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo  uuid;
    v_cola     jsonb;
    v_vent     jsonb;
    v_mi_modulo uuid;
BEGIN
    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    SELECT u.modulo_id INTO v_mi_modulo
      FROM public.usuarios u
     WHERE u.id = public.fn_usuario_actual();

    -- cola (igual que mig 37)
    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_cola
      FROM (
        SELECT jsonb_build_object(
            'turno_id',             t.id,
            'codigo_turno',         t.codigo,
            'folio',                t.folio,
            'clave_tramite',        tr.clave,
            'denominacion_tramite', tr.denominacion,
            'prioridad',            t.prioridad,
            'posicion',             row_number() OVER (
                                    ORDER BY CASE t.prioridad
                                                WHEN 'URGENTE' THEN 1
                                                WHEN 'PREFERENTE' THEN 2
                                                ELSE 3 END,
                                             t.creado_en, t.id),
            'posicion_llegada',     row_number() OVER (ORDER BY t.creado_en, t.id),
            'creado_en',            t.creado_en
        ) AS fila
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        WHERE t.estado = 'WAITING'
          AND t.periodo_operativo_id = v_periodo
      ) s;

    -- ventanillas
    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_vent
      FROM (
        SELECT jsonb_build_object(
            'modulo_id',            m.id,
            'codigo',               m.codigo,
            'denominacion',         m.denominacion,
            'estado',               m.estado,
            'activo',               m.activo,
            'estado_ventanilla',    CASE
                                        WHEN NOT (m.activo AND m.estado = 'ACTIVO')
                                            THEN 'SIN_DISPONIBILIDAD'
                                        WHEN a.turno_id IS NOT NULL
                                            THEN 'ATENDIENDO'
                                        ELSE 'DISPONIBLE'
                                    END,
            'disponible',           (m.activo AND m.estado = 'ACTIVO'
                                      AND a.turno_id IS NULL),
            'es_mia',               (m.id = v_mi_modulo),
            'ultima_asignacion_en', m.ultima_asignacion_en,
            'turno_id',             a.turno_id,
            'turno_codigo',         a.codigo,
            'turno_estado',         a.estado,
            'turno_clave_tramite',  tr.clave,
            'turno_denominacion_tramite', tr.denominacion,
            'turno_llamado_en',     a.llamado_en,
            'turno_inicio_atencion', a.inicio_atencion,
            'minutos_en_ventanilla', CASE
                WHEN a.llamado_en IS NULL THEN NULL
                ELSE floor(extract(epoch FROM (now() - a.llamado_en)) / 60)::int
            END,
            'operador_nombres',     u.nombres
        ) AS fila
        FROM public.modulos m
        LEFT JOIN LATERAL (
            SELECT t.id AS turno_id, t.codigo, t.estado, t.tramite_id,
                   t.llamado_en, t.inicio_atencion, t.atendido_por
              FROM public.turnos t
             WHERE t.modulo_id = m.id
               AND t.estado IN ('CALLED', 'SERVING')
             ORDER BY t.llamado_en DESC NULLS LAST, t.id
             LIMIT 1
        ) a ON true
        LEFT JOIN public.tramites tr ON tr.id = a.tramite_id
        LEFT JOIN public.usuarios u ON u.id = a.atendido_por
        ORDER BY m.codigo
      ) s;

    RETURN jsonb_build_object(
        'ok',          true,
        'periodo_id',  v_periodo,
        'cola',        v_cola,
        'ventanillas', v_vent
    );
END;
$$;

-- [4] solicitar_turno_ventanilla: solo la ventanilla propia -------------------
-- Se reabre la función para añadir la guarda. Se copia el cuerpo de la mig 37
-- con la comprobación insertada en el paso [2].
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

    -- Solo la ventanilla asignada al operador.
    IF v_modulo.id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RAISE EXCEPTION 'No puede operar una ventanilla que no le esta asignada.'
            USING ERRCODE = '42501';
    END IF;

    -- tope
    SELECT COALESCE((SELECT NULLIF(btrim(valor), '')::INTEGER FROM public.configuracion WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'), 3)
      INTO v_tope;
    SELECT COUNT(*) INTO v_abiertos FROM public.turnos
     WHERE modulo_id = v_modulo.id AND estado IN ('CALLED', 'SERVING');
    IF v_abiertos >= 1 OR v_tope <= 0 THEN
        RAISE EXCEPTION 'La ventanilla % esta atendiendo un turno. Termino o cancele antes de pedir otro.', v_modulo.codigo
            USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;
    IF v_periodo IS NULL THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto.' USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(4242::int, hashtext(v_periodo::text));

    -- dedupe
    SELECT id INTO v_solicitud FROM public.solicitudes_ventanilla
     WHERE periodo_operativo_id = v_periodo AND modulo_id = v_modulo.id AND operador_id = v_operador
     LIMIT 1;
    IF v_solicitud IS NULL THEN
        INSERT INTO public.solicitudes_ventanilla (periodo_operativo_id, modulo_id, operador_id)
        VALUES (v_periodo, v_modulo.id, v_operador)
        RETURNING id INTO v_solicitud;
    END IF;

    -- reparto
    LOOP
        EXIT WHEN public.fn_repartir_turnos_ventanilla(v_periodo) = 0;
    END LOOP;

    SELECT * INTO v_turno FROM public.turnos t
     WHERE t.modulo_id = v_modulo.id AND t.atendido_por = v_operador
       AND t.estado IN ('CALLED', 'SERVING')
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
        'modulo_codigo', v_modulo.codigo
    );
END;
$$;

-- [5] iniciar/finalizar/cancelar: AGENTE solo toca su ventanilla --------------
-- Se parchean las 3 funciones con una guarda condicional por rol.
CREATE OR REPLACE FUNCTION public.iniciar_atencion_turno(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    public.turnos%ROWTYPE;
    v_rol      text;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;
    IF NOT public.fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede iniciar atencion (RN-007).' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_turno FROM public.turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;
    SELECT r.clave INTO v_rol FROM public.roles r JOIN public.usuarios u ON u.rol_id = r.id WHERE u.id = v_operador;
    IF v_rol = 'AGENTE' AND v_turno.modulo_id IS NOT NULL AND v_turno.modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RAISE EXCEPTION 'No puede operar un turno de otra ventanilla.' USING ERRCODE = '42501';
    END IF;
    IF NOT public.fn_transicion_valida(v_turno.estado, 'SERVING') THEN
        RAISE EXCEPTION 'Transicion % -> SERVING no permitida (RN-004/RN-011).', v_turno.estado USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.turnos SET estado = 'SERVING', inicio_atencion = now(), atendido_por = COALESCE(v_turno.atendido_por, v_operador), token_expira_en = public.calcular_expiracion_token('SERVING') WHERE id = v_turno.id;
    PERFORM public.registrar_historial(v_turno.id, v_turno.estado, 'SERVING', v_operador, v_turno.modulo_id, 'Inicio de atencion.', NULL);
    PERFORM public.registrar_auditoria(v_operador, 'INICIAR_ATENCION', 'turnos', v_turno.id::text, 'EXITO', jsonb_build_object('codigo', v_turno.codigo));
    RETURN jsonb_build_object('ok', true, 'turno_id', v_turno.id, 'codigo_turno', v_turno.codigo, 'estado', 'SERVING');
END;
$$;

CREATE OR REPLACE FUNCTION public.finalizar_turno(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    public.turnos%ROWTYPE;
    v_rol      text;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;
    IF NOT public.fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede finalizar turnos (RN-007).' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_turno FROM public.turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;
    SELECT r.clave INTO v_rol FROM public.roles r JOIN public.usuarios u ON u.rol_id = r.id WHERE u.id = v_operador;
    IF v_rol = 'AGENTE' AND v_turno.modulo_id IS NOT NULL AND v_turno.modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RAISE EXCEPTION 'No puede operar un turno de otra ventanilla.' USING ERRCODE = '42501';
    END IF;
    IF NOT public.fn_transicion_valida(v_turno.estado, 'COMPLETED') THEN
        RAISE EXCEPTION 'Transicion % -> COMPLETED no permitida (RN-004/RN-011).', v_turno.estado USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.turnos SET estado = 'COMPLETED', finalizado_en = now(), atendido_por = COALESCE(v_turno.atendido_por, v_operador), token_expira_en = public.calcular_expiracion_token('COMPLETED') WHERE id = v_turno.id;
    PERFORM public.registrar_historial(v_turno.id, 'SERVING', 'COMPLETED', v_operador, v_turno.modulo_id, 'Atencion finalizada.', NULL);
    PERFORM public.registrar_auditoria(v_operador, 'FINALIZAR_TURNO', 'turnos', v_turno.id::text, 'EXITO', jsonb_build_object('codigo', v_turno.codigo));
    RETURN jsonb_build_object('ok', true, 'turno_id', v_turno.id, 'codigo_turno', v_turno.codigo, 'estado', 'COMPLETED', 'finalizado_en', now());
END;
$$;

CREATE OR REPLACE FUNCTION public.cancelar_turno(p_turno_id UUID, p_motivo TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    public.turnos%ROWTYPE;
    v_rol      text;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;
    IF NOT public.fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede cancelar turnos (RN-007).' USING ERRCODE = '42501';
    END IF;
    IF p_motivo IS NULL OR length(btrim(p_motivo)) = 0 THEN
        RAISE EXCEPTION 'La cancelacion requiere motivo (RF-016).' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_turno FROM public.turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;
    SELECT r.clave INTO v_rol FROM public.roles r JOIN public.usuarios u ON u.rol_id = r.id WHERE u.id = v_operador;
    IF v_rol = 'AGENTE' AND v_turno.modulo_id IS NOT NULL AND v_turno.modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RAISE EXCEPTION 'No puede operar un turno de otra ventanilla.' USING ERRCODE = '42501';
    END IF;
    IF NOT public.fn_transicion_valida(v_turno.estado, 'CANCELLED') THEN
        RAISE EXCEPTION 'Transicion % -> CANCELLED no permitida (RN-011).', v_turno.estado USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.turnos SET estado = 'CANCELLED', cancelado_en = now(), cancelado_por = v_operador, motivo_cancelacion = btrim(p_motivo), token_expira_en = public.calcular_expiracion_token('CANCELLED') WHERE id = v_turno.id;
    PERFORM public.registrar_historial(v_turno.id, v_turno.estado, 'CANCELLED', v_operador, v_turno.modulo_id, btrim(p_motivo), NULL);
    PERFORM public.registrar_auditoria(v_operador, 'CANCELAR_TURNO', 'turnos', v_turno.id::text, 'EXITO', jsonb_build_object('codigo', v_turno.codigo, 'motivo', btrim(p_motivo)));
    RETURN jsonb_build_object('ok', true, 'turno_id', v_turno.id, 'codigo_turno', v_turno.codigo, 'estado', 'CANCELLED', 'motivo', btrim(p_motivo));
END;
$$;

NOTIFY pgrst, 'reload schema';
