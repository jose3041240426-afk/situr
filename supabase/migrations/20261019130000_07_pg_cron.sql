-- ============================================================================
-- SITUR — MIGRACIÓN 007 (OPCIONAL): pg_cron
-- Solo para Supabase. En PostgreSQL local esta extensión no existe, por eso
-- va en un archivo aparte: el resto de la migración debe poder aplicarse
-- sin ella.
--
-- En Supabase: habilitar la extensión `pg_cron` desde el dashboard y luego
-- ejecutar este archivo.
--
-- Figura 11: el timeout de CALLED no depende de que un navegador esté abierto.
-- La función es idempotente (FOR UPDATE SKIP LOCKED), así que dos ejecuciones
-- solapadas nunca marcan dos veces el mismo turno.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Cada minuto: convertir a SKIPPED los turnos CALLED vencidos.
SELECT cron.schedule(
    'situr-timeout-called',
    '* * * * *',
    $$SELECT timeout_called_turns();$$
);

-- ---------------------------------------------------------------------------
-- PURGA DE TOKENS CADUCADOS
--
-- La función `purgar_tokens_caducados()` vive en 004_functions_rpc.sql: es
-- parte del catálogo de RPC y se prueba en la suite. Aquí solo se programa su
-- ejecución.
--
-- Para desactivarlo basta con quitar el cron:
--     SELECT cron.unschedule('situr-purga-tokens');
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
    'situr-purga-tokens',
    '17 * * * *',
    $$SELECT purgar_tokens_caducados();$$
);

-- Desprogramar (si se necesita):
--   SELECT cron.unschedule('situr-timeout-called');
--   SELECT cron.unschedule('situr-purga-tokens');
