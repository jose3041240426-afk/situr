-- ============================================================================
-- Migración 56 — Reparto respeta restricción de trámites por ventanilla
-- ============================================================================
-- Una ventanilla solo puede recibir turnos cuyo trámite esté en su lista
-- (modulo_tramites). Si la lista está vacía, atiende todos. El reparto
-- recorre los turnos en espera (FIFO) y asigna el primero que alguna
-- ventanilla disponible pueda atender.
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
    v_allowed   uuid[];
    v_encontrado boolean := false;
BEGIN
    PERFORM pg_advisory_xact_lock(4242::int, hashtext(p_periodo_id::text));

    SELECT COALESCE(
        (SELECT NULLIF(btrim(valor), '')::INTEGER
           FROM configuracion
          WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'),
        3
    ) INTO v_tope;

    -- Recorrer turnos en espera (FIFO) hasta encontrar uno asignable.
    FOR v_turno IN
        SELECT * FROM turnos
         WHERE periodo_operativo_id = p_periodo_id
           AND estado = 'WAITING'
         ORDER BY creado_en, id
         FOR UPDATE SKIP LOCKED
    LOOP
        -- Buscar una ventanilla disponible que permita este trámite.
        FOR v_sol IN
            SELECT sv.* FROM solicitudes_ventanilla sv
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
        LOOP
            v_allowed := public.tramites_permitidos_modulo(v_sol.modulo_id);
            -- Si la lista está vacía, la ventanilla atiende todos.
            IF (v_allowed IS NULL OR array_length(v_allowed, 1) IS NULL
                OR v_turno.tramite_id = ANY (v_allowed)) THEN
                v_encontrado := true;
                EXIT;
            END IF;
        END LOOP;

        EXIT WHEN v_encontrado;
    END LOOP;

    IF NOT v_encontrado THEN
        RETURN 0;
    END IF;

    -- [C] TRANSICIÓN VÁLIDA
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

    DELETE FROM solicitudes_ventanilla WHERE id = v_sol.id;

    INSERT INTO historial_turnos
        (turno_id, estado_anterior, estado_nuevo, usuario_id, modulo_id, motivo, metadata)
    VALUES (
        v_turno.id, 'WAITING', 'ASIGNED', v_sol.operador_id, v_sol.modulo_id,
        'Asignado a ventanilla (FIFO por llegada, restriccion de tramite)',
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
  'Asigna el siguiente turno WAITING (FIFO) a una ventanilla disponible que permita su tramite, hasta MAXIMO_TURNOS_EN_ATENCION por ventanilla.';

NOTIFY pgrst, 'reload schema';
