-- ===========================================================================
-- 042 — Fix: fn_repartir_turnos_ventanilla usa COUNT < tope en lugar de NOT EXISTS
-- ===========================================================================
--
-- Problema: la condición `NOT EXISTS (SELECT 1 FROM turnos ...)` bloqueaba
-- una ventanilla después de asignarle 1 turno, impidiendo que aceptara hasta
-- MAXIMO_TURNOS_EN_ATENCION (3).
--
-- Solución: reemplazar NOT EXISTS por `(SELECT COUNT(*)) < v_tope` para que
-- una ventanilla pueda recibir turnos mientras no alcance el tope configurado.
-- ===========================================================================

BEGIN;

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
    -- FIX: usar COUNT < v_tope en lugar de NOT EXISTS para permitir hasta 3 turnos
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

    -- [C] TRANSICIÓN VÁLIDA (RN-011) ---------------------------------------
    IF NOT fn_transicion_valida(v_turno.estado, 'ASIGNED') THEN
        RAISE EXCEPTION 'Transicion % -> ASIGNED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    -- [D] ASIGNAR -----------------------------------------------------------
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

COMMENT ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) IS
  'Asigna el siguiente turno WAITING a una ventanilla (hasta MAXIMO_TURNOS_EN_ATENCION por ventanilla, mig 42).';

REVOKE ALL ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) TO authenticated;

COMMIT;
