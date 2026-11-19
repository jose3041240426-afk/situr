-- ===========================================================================
-- 060 — Push al transferir: marcar el cambio de ventanilla y devolver turno_id
-- ===========================================================================
--
-- PROBLEMA 1: al aceptar una transferencia desde el panel de la campana, el
-- ciudadano no recibía el aviso «transferido a V2».
--
--   La detección de la transferencia (mig 57) vive en `modulo_id_anterior`,
--   pero solo `transferir_turno_ventanilla` lo escribía. La función que usa
--   la interfaz, `responder_transferencia`, movía el turno con
--   `SET modulo_id = destino` SIN guardar el módulo anterior, así que
--   `suscripciones_por_notificar` seguía viendo un ASIGNADO normal (o nada)
--   en vez de un TRANSFERIDO.
--
-- PROBLEMA 2: el cliente no tenía el `turno_id` de forma fiable. Lo buscaba
--   en la lista de pendientes del navegador, que solo publica la pantalla de
--   turnos: si la aceptación venía de otra pantalla, la lista estaba vacía y
--   el aviso no se mandaba. La función ahora lo devuelve.
--
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.responder_transferencia(p_solicitud_id bigint, p_aceptar boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    v_operador uuid;
    v_sol public.solicitudes_transferencia%ROWTYPE;
    v_destino_count integer;
    v_destino_anterior uuid;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_sol FROM public.solicitudes_transferencia
     WHERE id = p_solicitud_id AND estado = 'PENDIENTE' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'Solicitud no encontrada o ya resuelta.');
    END IF;

    -- Solo el operador de la ventanilla destino puede responder; un
    -- administrador o supervisor también, para destrabar la cola.
    IF v_sol.destino_modulo_id IS DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador) THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.usuarios u
            JOIN public.roles r ON r.id = u.rol_id
            WHERE u.id = v_operador AND r.clave IN ('ADMINISTRADOR','SUPERVISOR')
        ) THEN
            RETURN jsonb_build_object('ok', false, 'motivo', 'Solo la ventanilla destino puede responder.');
        END IF;
    END IF;

    IF NOT p_aceptar THEN
        UPDATE public.solicitudes_transferencia
           SET estado = 'RECHAZADA', resuelto_en = now()
         WHERE id = p_solicitud_id;
        RETURN jsonb_build_object('ok', true, 'motivo', 'Transferencia rechazada.', 'turno_id', v_sol.turno_id);
    END IF;

    -- Verificar cupo destino (3 turnos en atención a la vez).
    SELECT COUNT(*) INTO v_destino_count
    FROM public.turnos t
    WHERE t.modulo_id = v_sol.destino_modulo_id
      AND t.estado IN ('ASIGNED','CALLED','SERVING');
    IF v_destino_count >= 3 THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'La ventanilla destino ya tiene 3 turnos.', 'turno_id', v_sol.turno_id);
    END IF;

    -- Mover el turno. Se guarda el módulo ANTERIOR en la misma fila: es la
    -- única pista de que esto fue una transferencia y no una asignación
    -- nueva, y de ella cuelga el aviso TRANSFERIDO (mig 57).
    UPDATE public.turnos
       SET modulo_id_anterior = modulo_id,
           modulo_id = v_sol.destino_modulo_id,
           atendido_por = (SELECT id FROM public.usuarios WHERE modulo_id = v_sol.destino_modulo_id LIMIT 1)
     WHERE id = v_sol.turno_id;

    UPDATE public.solicitudes_transferencia
       SET estado = 'ACEPTADA', resuelto_en = now()
     WHERE id = p_solicitud_id;

    PERFORM public.registrar_auditoria(
        v_operador, 'TRANSFERIR_TURNO', 'turnos', v_sol.turno_id::text, 'EXITO',
        jsonb_build_object('destino', (SELECT codigo FROM public.modulos WHERE id = v_sol.destino_modulo_id))
    );

    RETURN jsonb_build_object('ok', true, 'motivo', 'Transferencia aceptada.', 'turno_id', v_sol.turno_id);
END;
$function$;

COMMENT ON FUNCTION public.responder_transferencia(bigint, boolean) IS
  'Mig 60: al aceptar guarda modulo_id_anterior (aviso TRANSFERIDO) y devuelve turno_id para que el cliente pueda avisar al ciudadano sin depender de su estado local.';

NOTIFY pgrst, 'reload schema';

COMMIT;
