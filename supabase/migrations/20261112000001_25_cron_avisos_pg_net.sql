-- ===========================================================================
-- 025 — El aviso de turno se dispara desde pg_cron, no desde GitHub Actions
-- ===========================================================================
--
-- PROBLEMA
-- El aviso push se venía disparando con un cron de GitHub Actions declarado
-- como `*/5 * * * *`, es decir, "cada cinco minutos". En la práctica ese
-- cron NO corría cada cinco minutos: los intervalos reales medidos entre
-- ejecuciones fueron de 4,8 a 7,8 HORAS. GitHub Actions no garantiza la
-- hora de los cron programados, y en un repositorio pequeño el retraso es
-- de horas.
--
-- Con ese retraso la ventana de aviso se cerraba siempre. La cola
-- `suscripciones_por_notificar()` solo entrega un turno en estado CALLED
-- mientras el operador tarda en iniciar la atención (uno, dos o tres
-- minutos). Cuando el cron llegaba, el turno ya había pasado a SERVING, y
-- para SERVING no hay ninguna regla de aviso: el ciudadano se quedaba sin
-- saber que lo habían llamado.
--
-- SOLUCIÓN
-- Mover la invocación del emisor dentro de PostgreSQL, que ya usa pg_cron
-- para el cierre por timeout. Con la extensión pg_net la base llama por
-- HTTP a /api/push, así que el aviso se evalúa cada minuto de verdad y sin
-- depender de que un servicio externo se acuerde de llamarnos.
--
-- El token de invocación NO vive en el repositorio: está en Supabase Vault
-- (secreto 'situr_push_token') y su copia vive en la variable de entorno
-- SITUR_PUSH_TOKEN de Vercel. La base lee el secreto de Vault y la función
-- de Vercel comprueba la coincidencia.
--
-- El cron de GitHub Actions se deja de usar para esto: seguiría gastando
-- minutos de Actions para hacer lo mismo con horas de retraso.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) La extensión pg_net: permite que la base haga peticiones HTTP.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- 2) La función que invoca al emisor de avisos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION situr_llamar_emisor_de_avisos()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_token TEXT;
    v_url   TEXT;
BEGIN
    -- El token vive en Vault, no en el código ni en el repositorio.
    SELECT decrypted_secret
      INTO v_token
      FROM vault.decrypted_secrets
     WHERE name = 'situr_push_token';

    IF v_token IS NULL OR v_token = '' THEN
        RAISE WARNING 'SITUR: no hay secreto situr_push_token en Vault; no se envía ningún aviso.';
        RETURN;
    END IF;

    -- La URL del emisor es configurable, para no tenerla escrita en el código.
    v_url := fn_config_texto('URL_EMISOR_AVISOS', 'https://situr.vercel.app/api/push');

    -- pg_net encola la petición y la entrega al cerrar la transacción.
    PERFORM net.http_post(
        url := v_url,
        body := '{}'::jsonb,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_token
        ),
        timeout_milliseconds := 20000
    );
END;
$$;

COMMENT ON FUNCTION situr_llamar_emisor_de_avisos() IS
    'Invoca /api/push una vez por minuto para entregar los avisos de turno. El token de invocación se lee de Supabase Vault.';

-- ---------------------------------------------------------------------------
-- 3) La URL del emisor, como parámetro y no como constante en el código.
-- ---------------------------------------------------------------------------
INSERT INTO configuracion (clave, nombre, valor, tipo, descripcion)
VALUES (
    'URL_EMISOR_AVISOS',
    'URL del emisor de avisos push',
    'https://situr.vercel.app/api/push',
    'TEXTO',
    'Endpoint de Vercel al que pg_cron llama cada minuto para entregar los avisos de turno.'
)
ON CONFLICT (clave) DO UPDATE
   SET descripcion = EXCLUDED.descripcion;

-- ---------------------------------------------------------------------------
-- 4) El job: cada minuto, como los otros dos trabajos de pg_cron.
-- ---------------------------------------------------------------------------
-- Para desactivarlo:
--     SELECT cron.unschedule('situr-avisos-push');
SELECT cron.schedule(
    'situr-avisos-push',
    '* * * * *',
    $$SELECT situr_llamar_emisor_de_avisos();$$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
