-- ===========================================================================
-- 034 — Corregir search_path de funciones que usan gen_random_bytes()
-- ===========================================================================
--
-- La migración 32 (rol RECEPCIÓN) recreó generar_turno() y reponer_turno()
-- con SET search_path = public, pg_temp, omitiendo el esquema `extensions`
-- donde Supabase instala pgcrypto. Esto hace que gen_random_bytes(32) falle
-- con "function gen_random_bytes(integer) does not exist".
--
-- Esta migración corrige el search_path para que ambas funciones vean
-- `extensions` y puedan usar gen_random_bytes sin error.
-- ===========================================================================

BEGIN;

ALTER FUNCTION generar_turno(uuid, enum_prioridad_turno)
    SET search_path = public, extensions, pg_temp;

ALTER FUNCTION reponer_turno(uuid)
    SET search_path = public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';

COMMIT;
