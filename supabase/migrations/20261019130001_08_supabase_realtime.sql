-- ============================================================================
-- SITUR — MIGRACIÓN 008: REALTIME (solo Supabase)
--
-- Esta migración es OPCIONAL y SOLO aplica en Supabase: usa el esquema
-- `realtime`, que no existe en un PostgreSQL vanilla. Por eso va aparte y
-- `aplicar.sh` no la incluye en la serie 001..006.
--
-- Qué hace:
--   1. Publica `turnos` en la publicación de Realtime, para que el PANEL
--      DEL OPERADOR reciba los cambios al instante.
--   2. Añade el disparador que difunde el cambio al CANAL DEL CIUDADANO.
--
-- El canal NO transporta datos del turno (RF-019): solo avisa de que algo
-- cambió, y el cliente vuelve a preguntar con `get_turno_publico(token)`.
--
-- La aplicación NO depende de esto: el panel refresca cada 15 s y el portal
-- del ciudadano sondea cada 10 s. Realtime solo lo hace inmediato.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) El panel del operador
--
-- `turnos` debe estar en la publicación para que el panel reciba los
-- INSERT/UPDATE. La RLS se sigue aplicando: la política `p_admin_turnos`
-- decide quién ve qué.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'turnos'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.turnos;
            RAISE NOTICE 'turnos publicada en supabase_realtime';
        ELSE
            RAISE NOTICE 'turnos ya estaba publicada en supabase_realtime';
        END IF;
    ELSE
        RAISE NOTICE 'no existe la publicación supabase_realtime: se omite (no es Supabase)';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) El portal del ciudadano
--
-- `realtime.send()` publica en un canal. El canal se llama con el token
-- público del turno: quien no conozca el token no puede ni subscribirse ni
-- hacer la pregunta que de verdad importa (que va con su token y devuelve
-- solo los 5 campos públicos).
--
-- El aviso va marcado como `private = TRUE`, así que si en Supabase se
-- configuran políticas sobre `realtime.messages`, el canal exige la sesión
-- legítima. Con `private = FALSE` funciona sin configurar nada, que es lo
-- adecuado para un ciudadano anónimo: el token ES la autorización.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_difundir_cambio_turno()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Solo se difunde cuando el estado cambia de verdad: un cambio de
    -- `token_ultimo_acceso` (que hace la propia consulta ciudadana) no
    -- debe provocar una notificación.
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        BEGIN
            PERFORM realtime.send(
                jsonb_build_object('cambio', true, 'estado', NEW.estado),
                'turno-cambio',
                'turno:' || NEW.token_publico,
                FALSE
            );
        EXCEPTION WHEN others THEN
            -- Si Realtime no está disponible, la difusión no debe impedir
            -- la transición del turno: la aplicación sondea igual.
            RAISE WARNING 'no se pudo difundir el cambio del turno %: %', NEW.id, SQLERRM;
        END;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_difundir_cambio_turno() IS
    'RF-019: difunde que un turno cambio de estado. El canal NO transporta datos del turno; el cliente vuelve a consultar get_turno_publico(token).';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_difundir_cambio_turno'
    ) THEN
        CREATE TRIGGER trg_difundir_cambio_turno
            AFTER UPDATE OF estado ON public.turnos
            FOR EACH ROW
            EXECUTE FUNCTION public.fn_difundir_cambio_turno();
        RAISE NOTICE 'disparador de difusion creado';
    END IF;
END;
$$;
