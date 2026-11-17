-- ============================================================================
-- Migración 49 — Transferencias con solicitud y aceptación (mig 49)
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.solicitudes_transferencia (
    id                  bigserial PRIMARY KEY,
    periodo_operativo_id uuid NOT NULL REFERENCES public.periodos_operativos(id) ON DELETE CASCADE,
    turno_id            uuid NOT NULL REFERENCES public.turnos(id) ON DELETE CASCADE,
    origen_modulo_id    uuid NOT NULL REFERENCES public.modulos(id),
    destino_modulo_id   uuid NOT NULL REFERENCES public.modulos(id),
    solicitante_id      uuid NOT NULL REFERENCES public.usuarios(id),
    estado              text NOT NULL DEFAULT 'PENDIENTE'
                        CHECK (estado IN ('PENDIENTE','ACEPTADA','RECHAZADA')),
    creado_en           timestamptz NOT NULL DEFAULT now(),
    resuelto_en         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sol_transfer_destino_pendiente
  ON public.solicitudes_transferencia (destino_modulo_id)
  WHERE estado = 'PENDIENTE';

-- solicitar_transferencia: crea una solicitud PENDIENTE (no mueve el turno)
CREATE OR REPLACE FUNCTION public.solicitar_transferencia(p_turno_id uuid, p_destino_modulo_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_rol text;
    v_turno public.turnos%ROWTYPE;
    v_periodo uuid;
    v_origen_modulo uuid;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT r.clave INTO v_rol FROM public.roles r JOIN public.usuarios u ON u.rol_id = r.id WHERE u.id = v_operador;
    IF v_rol NOT IN ('AGENTE','ADMINISTRADOR','SUPERVISOR') THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No tienes permiso para transferir turnos.');
    END IF;

    SELECT * INTO v_turno FROM public.turnos WHERE id = p_turno_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Turno no encontrado.');
    END IF;
    IF v_turno.estado != 'ASIGNED' THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Solo se pueden transferir turnos asignados.');
    END IF;

    -- ownership for AGENTE
    IF v_rol = 'AGENTE' AND v_turno.modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No puede transferir un turno de otra ventanilla.');
    END IF;

    IF v_turno.modulo_id = p_destino_modulo_id THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'El turno ya está en esa ventanilla.');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.modulos WHERE id = p_destino_modulo_id AND activo = true AND estado = 'ACTIVO') THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino no está activa.');
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;
    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'No hay periodo operativo abierto.');
    END IF;

    -- evita duplicados pendientes
    IF EXISTS (SELECT 1 FROM public.solicitudes_transferencia WHERE turno_id = p_turno_id AND estado = 'PENDIENTE') THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Ya hay una solicitud pendiente para este turno.');
    END IF;

    INSERT INTO public.solicitudes_transferencia (periodo_operativo_id, turno_id, origen_modulo_id, destino_modulo_id, solicitante_id)
    VALUES (v_periodo, p_turno_id, v_turno.modulo_id, p_destino_modulo_id, v_operador);

    RETURN jsonb_build_object('ok', true, 'motivo', 'Solicitud enviada. Esperando aceptación de la ventanilla destino.');
END;
$$;

-- responder_transferencia: destino acepta o rechaza
CREATE OR REPLACE FUNCTION public.responder_transferencia(p_solicitud_id bigint, p_aceptar boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_sol public.solicitudes_transferencia%ROWTYPE;
    v_destino_count integer;
    v_destino_operador uuid;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_sol FROM public.solicitudes_transferencia WHERE id = p_solicitud_id AND estado = 'PENDIENTE' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Solicitud no encontrada o ya resuelta.');
    END IF;

    -- solo el operador de la ventanilla destino puede responder
    IF v_sol.destino_modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        -- admin/supervisor can also respond
        IF NOT EXISTS (SELECT 1 FROM public.usuarios u JOIN public.roles r ON r.id=u.rol_id WHERE u.id=v_operador AND r.clave IN ('ADMINISTRADOR','SUPERVISOR')) THEN
            RETURN jsonb_build_object('ok', false, 'motivo', 'Solo la ventanilla destino puede responder.');
        END IF;
    END IF;

    IF NOT p_aceptar THEN
        UPDATE public.solicitudes_transferencia
           SET estado = 'RECHAZADA', resuelto_en = now()
         WHERE id = p_solicitud_id;
        RETURN jsonb_build_object('ok', true, 'motivo', 'Transferencia rechazada.');
    END IF;

    -- aceptar: verificar cupo destino
    SELECT COUNT(*) INTO v_destino_count
    FROM public.turnos t
    WHERE t.modulo_id = v_sol.destino_modulo_id
      AND t.estado IN ('ASIGNED','CALLED','SERVING');
    IF v_destino_count >= 3 THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino ya tiene 3 turnos.');
    END IF;

    -- mover el turno
    UPDATE public.turnos
       SET modulo_id = v_sol.destino_modulo_id,
           atendido_por = (SELECT id FROM public.usuarios WHERE modulo_id = v_sol.destino_modulo_id LIMIT 1)
     WHERE id = v_sol.turno_id;

    UPDATE public.solicitudes_transferencia
       SET estado = 'ACEPTADA', resuelto_en = now()
     WHERE id = p_solicitud_id;

    PERFORM public.registrar_auditoria(
        v_operador, 'TRANSFERIR_TURNO', 'turnos', v_sol.turno_id::text, 'EXITO',
        jsonb_build_object('destino', (SELECT codigo FROM public.modulos WHERE id = v_sol.destino_modulo_id))
    );

    RETURN jsonb_build_object('ok', true, 'motivo', 'Transferencia aceptada.');
END;
$$;

-- estado_ventanillas: añadir transferencias_pendientes por ventanilla
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
            END AS disponible,
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

GRANT EXECUTE ON FUNCTION public.solicitar_transferencia(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.responder_transferencia(bigint, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
