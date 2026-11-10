-- ============================================================================
-- SITUR — STUBS PARA PRUEBA EN POSTGRESQL LOCAL
-- ESTE ARCHIVO NO FORMA PARTE DE LA MIGRACIÓN DE PRODUCCIÓN.
--
-- Es el mismo contenido que `../../migracion/prueba/00_stubs.sql`, copiado
-- aquí porque `pruebas/levantar.sh` y `pruebas/reiniciar-base.sh` lo aplican
-- con `-f "$DIR/00_stubs.sql"` y el repositorio tiene que poder levantarse
-- sin la carpeta hermana `migracion/`.
--
-- La migración apunta a Supabase y usa:
--   * los roles `anon`, `authenticated` y `service_role`
--   * el esquema `auth` con la función auth.uid()
-- Ninguno de los tres existe en un PostgreSQL vanilla. Este archivo los crea
-- para poder aplicar y PROBAR la migración en local.
--
-- Orden de ejecución:
--   00_stubs.sql -> 01..06 -> (07 y 08, solo Supabase) -> 09..19
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS auth;

-- auth.uid() real de Supabase lee el JWT. Aquí se sustituye por una versión
-- que funciona en los dos escenarios:
--
--   * `app.uid`         -> lo usa la suite de pruebas (SET app.uid = '<uuid>')
--   * `request.jwt.claims` -> lo usa PostgREST/Supabase, que lo rellena con
--                             el claims del token de la petición
--
-- Con los dos, la misma base sirve para la suite local y para probar la
-- aplicación contra la base real, con la RLS real.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(
        COALESCE(
            NULLIF(current_setting('app.uid', TRUE), ''),
            NULLIF(current_setting('request.jwt.claim.sub', TRUE), ''),
            (NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb ->> 'sub')
        ),
        ''
    )::uuid;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
END;
$$;

-- Supabase concede TODOS los privilegios de objeto a estos tres roles y deja
-- que RLS filtre las filas. Se reproduce aquí para que la migración 05 se
-- pruebe en las mismas condiciones reales: si su REVOKE sobre `anon` no
-- funcionara, el test lo detectaría porque `anon` seguiría con SELECT sobre
-- `turnos`.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
