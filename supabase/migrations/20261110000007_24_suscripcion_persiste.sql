-- ===========================================================================
-- 024 — La suscripción se desactiva, no se borra
-- ===========================================================================
--
-- PROBLEMA
-- El disparador `trg_turnos_retirar_suscripcion_push` hace DELETE de la
-- suscripción push cuando el turno llega a COMPLETED/CANCELLED/SKIPPED. El
-- ciudadano se suscribe, el turno se omite por timeout (5 min) y la
-- suscripción desaparece: la siguiente prueba dice «No hay suscripción para
-- este turno» aunque el móvil la tuviera guardada.
--
-- También borra el historial de a quién se avisó, lo que impide saber si el
-- primer envío llegó o no.
--
-- SOLUCIÓN
-- Marcarla como inactiva (`activa = false`) en vez de borrarla. La cola de
-- avisos ya filtra por `s.activa`, así que no se mandan avisos a turnos
-- terminados; pero la fila queda para saber a quién se avisó y para que el
-- ciudadano no tenga que volver a aceptar el permiso del navegador si
-- reutiliza el mismo dispositivo.
--
-- El borrado real sigue ocurriendo en `/api/push`, cuando el proveedor de
-- push responde 404/410: eso sí significa que el endpoint murió.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_retirar_suscripcion_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE suscripciones_push
       SET activa = false,
           ultima_activacion = COALESCE(ultima_activacion, now())
     WHERE token_publico = OLD.token_publico;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_retirar_suscripcion_push() IS
    'RF-028: desactiva la suscripcion push cuando el turno alcanza un estado terminal. El borrado real solo ocurre si el proveedor devuelve 404/410.';

NOTIFY pgrst, 'reload schema';

COMMIT;
