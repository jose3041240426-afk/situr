-- ===========================================================================
-- 061 — Aviso push en el acto, desde la base de datos
-- ===========================================================================
--
-- PROBLEMA
--
--   El aviso inmediato vivía en el NAVEGADOR: cada pantalla mandaba
--   `POST /api/push?turno_id=...` después de cambiar el turno. Eso era
--   intermitente y lento, por tres razones:
--
--     1. Solo funcionaba si esa pantalla concreta lo hacía. El reparto
--        AUTOMÁTICO de ventanillas ocurre dentro de PostgreSQL y no pasa
--        por ningún navegador: esos turnos solo se avisaban con la vuelta
--        del cron, es decir, con hasta 60 segundos de retraso (medido:
--        asignados 07:57:53-55, avisados 07:58:00; asignado 08:01:11,
--        avisado 08:02:00).
--     2. Dependía de que el navegador tuviera la sesión fresca, la pestaña
--        abierta y el bundle actualizado: si algo fallaba, nadie se
--        enteraba (el error se tragaba) y el turno quedaba sin avisar hasta
--        el cron.
--     3. Dos vías a la vez no valen: el Service Worker usa `renotify: true`,
--        así que un aviso repetido vuelve a vibrar y a sonar. Tiene que
--        existir UNA sola vía inmediata.
--
-- SOLUCIÓN
--
--   El aviso se encola desde el propio PostgreSQL, en el mismo momento en
--   que el turno cambia, sea cual sea la vía (manual, reparto automático,
--   transferencia, llamada o repetición). pg_net entrega la petición al
--   cerrar la transacción, así que el emisor siempre ve el turno ya
--   cambiado, y el navegador no tiene que hacer nada.
--
--   El cron de un minuto se queda igual, como respaldo: si pg_net no
--   pudiera encolar, el ciudadano recibe el aviso igual, tarde.
--
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) El encolado, con el mismo patrón que ya usa el cron.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.situr_aviso_inmediato(p_turno_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_token text;
    v_url   text;
BEGIN
    IF p_turno_id IS NULL THEN
        RETURN;
    END IF;

    BEGIN
        -- El token vive en Vault, no en el código ni en el repositorio.
        SELECT decrypted_secret
          INTO v_token
          FROM vault.decrypted_secrets
         WHERE name = 'situr_push_token';

        IF v_token IS NULL OR v_token = '' THEN
            -- Sin secreto no se encola: el cron es el respaldo.
            RETURN;
        END IF;

        v_url := public.fn_config_texto('URL_EMISOR_AVISOS', 'https://situr.vercel.app/api/push');

        PERFORM net.http_post(
            url := v_url || '?turno_id=' || p_turno_id::text,
            body := '{}'::jsonb,
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_token
            ),
            timeout_milliseconds := 20000
        );
    EXCEPTION WHEN OTHERS THEN
        -- Un fallo de push NUNCA puede impedir llamar o asignar un turno.
        RAISE WARNING 'SITUR: no se pudo encolar el aviso de %: %', p_turno_id, SQLERRM;
    END;
END;
$function$;

COMMENT ON FUNCTION public.situr_aviso_inmediato(uuid) IS
  'Mig 61: encola el aviso push de un turno en el acto. Devuelve siempre; si falla, el cron de un minuto es el respaldo.';

-- ---------------------------------------------------------------------------
-- 2) El disparador: un solo punto para todas las vías de cambio.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_aviso_inmediato_turno()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
    -- Llamado: entra en CALLED (primera llamada) o se repite (cambia
    -- llamado_en). Las dos condiciones por separado, por si una llamada
    -- llegara con el mismo llamado_en que ya traía.
    IF NEW.estado = 'CALLED' AND (
        OLD.estado <> 'CALLED'
        OR NEW.llamado_en IS DISTINCT FROM OLD.llamado_en
    ) THEN
        PERFORM public.situr_aviso_inmediato(NEW.id);
        RETURN NEW;
    END IF;

    -- Asignado a una ventanilla (manual o reparto automático), o movido de
    -- ventanilla (transferencia): sigue ASIGNED pero en otro módulo.
    IF NEW.estado = 'ASIGNED' AND (
        OLD.estado <> 'ASIGNED'
        OR NEW.modulo_id IS DISTINCT FROM OLD.modulo_id
    ) THEN
        PERFORM public.situr_aviso_inmediato(NEW.id);
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_aviso_inmediato_turno ON public.turnos;

CREATE TRIGGER trg_aviso_inmediato_turno
AFTER UPDATE ON public.turnos
FOR EACH ROW
WHEN (
    OLD.estado IS DISTINCT FROM NEW.estado
    OR OLD.modulo_id IS DISTINCT FROM NEW.modulo_id
    OR OLD.llamado_en IS DISTINCT FROM NEW.llamado_en
)
EXECUTE FUNCTION public.fn_aviso_inmediato_turno();

COMMENT ON TRIGGER trg_aviso_inmediato_turno ON public.turnos IS
  'Mig 61: encola el aviso push cuando el turno se asigna, se transfiere o se llama, sea cual sea la vía.';

COMMIT;
