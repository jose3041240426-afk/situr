-- ============================================================================
-- Migración 53 — FIFO estricto en la asignación a ventanillas (sin prioridad)
-- ============================================================================
-- Antes, fn_repartir_turnos_ventanilla elegía el siguiente turno a asignar
-- con ORDER BY (URGENTE→PREFERENTE→NORMAL, creado_en, id), por lo que un turno
-- urgente que llegaba después saltaba por delante de los normales. El usuario
-- pide cola FIFO: el primero que llegó es el primero que se asigna/sirve.
--
-- Se elimina la prioridad del ORDER BY de asignación (solo creado_en, id).
-- El reparto entre ventanillas (menos turnos → menos recientemente asignada)
-- NO cambia: sigue siendo equitativo y no serializa ventanillas entre sí.
-- La prioridad se mantiene para la VISUALIZACIÓN (cola en vivo / TV), no
-- para decidir quién se asigna primero.
-- ============================================================================
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

    -- [A] QUÉ TURNO SE ENTREGA: FIFO estricto por llegada (sin prioridad)
    SELECT * INTO v_turno
      FROM turnos
     WHERE periodo_operativo_id = p_periodo_id
       AND estado = 'WAITING'
     ORDER BY creado_en, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- [B] A QUIÉN SE ENTREGA (reparto equitativo entre ventanillas, sin cambio)
    SELECT sv.* INTO v_sol
      FROM solicitudes_ventanilla sv
      JOIN modulos m ON m.id = sv.modulo_id
     WHERE sv.periodo_operativo_id = p_periodo_id
       AND m.activo
       AND m.estado = 'ACTIVO'
       AND (
           SELECT COUNT(*)
             FROM turnos t
            WHERE t.modulo_id = m.id
              AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
       ) < v_tope
     ORDER BY COALESCE(m.ultima_asignacion_en, '-infinity'::timestamptz) ASC,
              sv.creado_en ASC,
              sv.id ASC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- [C] TRANSICIÓN VÁLIDA (RN-011)
    IF NOT fn_transicion_valida(v_turno.estado, 'ASIGNED') THEN
        RAISE EXCEPTION 'Transicion % -> ASIGNED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    -- [D] ASIGNAR
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

    -- [E] LIMPIAR SOLICITUD
    DELETE FROM solicitudes_ventanilla WHERE id = v_sol.id;

    -- [F] TRAZA
    INSERT INTO historial_turnos
        (turno_id, estado_anterior, estado_nuevo, usuario_id, modulo_id, motivo, metadata)
    VALUES (
        v_turno.id, 'WAITING', 'ASIGNED', v_sol.operador_id, v_sol.modulo_id,
        'Asignado a ventanilla (FIFO por llegada)',
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

    -- Notificar a la ventanilla destino.
    PERFORM pg_notify(
        'turnos_cambios',
        jsonb_build_object(
            'tipo', 'ASIGNADO',
            'turno_id', v_turno.id::text,
            'codigo', v_turno.codigo,
            'modulo_id', v_sol.modulo_id::text,
            'modulo_codigo', (SELECT codigo FROM modulos WHERE id = v_sol.modulo_id)
        )::text
    );

    v_servidas := v_servidas + 1;
    RETURN v_servidas;
END;
$$;

COMMENT ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) IS
  'Asigna el siguiente turno WAITING a una ventanilla por FIFO estricto (creado_en, id), hasta MAXIMO_TURNOS_EN_ATENCION por ventanilla.';

NOTIFY pgrst, 'reload schema';
