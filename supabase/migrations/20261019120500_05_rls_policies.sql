-- ============================================================================
-- SITUR — MIGRACIÓN 005: RLS Y BLINDAJE DE TABLAS
-- Modelo de datos FUSIONADO v2.0
--
-- Objetivo: el ciudadano (rol `anon`) NUNCA hace SELECT sobre `turnos`
-- (Figura 9, RF-019, criterio de aceptación "prueba de fuga de datos").
--
-- Patrón: RLS apagado por defecto = sin políticas = sin acceso. Se añade una
-- única política administrativa por tabla y no se crea ninguna para `anon`,
-- de modo que el único camino de lectura pública es la RPC
-- get_turno_publico(), que devuelve 5 campos.
--
-- TOMA_TURNO no tenía absolutamente nada de esto: su tabla `turnos` era
-- legible directamente por cualquiera con credenciales de la base.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. AUDITORÍA DE SOLO-INSERCIÓN (RF-024, RN-016)
-- "Tabla solo-inserción: INSERT interno permitido, SELECT según rol,
--  UPDATE/DELETE prohibidos."
--
-- El trigger es la garantía real: una RLS mal escrita o un backend con
-- `service_role` (que BYPASSRLS) no podrían reescribir el historial de quién
-- hizo qué. Se bloquea UPDATE incluso al propietario de la tabla: arreglar un
-- registro de auditoría debe ser un acto explícito y consciente, no un UPDATE
-- cualquiera. DELETE queda reservado a la retención de datos, para el
-- propietario o `service_role`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion_auditoria()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_dueno TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'auditoria es de solo-insercion (RF-024): UPDATE prohibido.'
            USING ERRCODE = '42501';
    END IF;

    SELECT tableowner INTO v_dueno
      FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'auditoria';

    IF current_user IN (COALESCE(v_dueno, 'postgres'), 'service_role', 'supabase_admin') THEN
        RETURN NULL;
    END IF;

    RAISE EXCEPTION 'auditoria es de solo-insercion (RF-024): DELETE prohibido.'
        USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER trg_auditoria_solo_insercion
    BEFORE UPDATE OR DELETE ON auditoria
    FOR EACH ROW
    EXECUTE FUNCTION fn_bloquear_modificacion_auditoria();

COMMENT ON FUNCTION fn_bloquear_modificacion_auditoria IS
    'RF-024: impide UPDATE/DELETE sobre auditoria salvo para el propietario o service_role.';

-- ---------------------------------------------------------------------------
-- A bis. AUDITORÍA: el `metadata` no puede llevar la credencial del ciudadano
--
-- El DRS §11 dice que `metadata` NO debe contener tokens completos, ni
-- contraseñas, ni credenciales. Hasta ahora eso era una convención y una
-- aserción de la suite, no una garantía de la base: cualquier RPC nueva
-- podía colar un token sin que nada se lo impidiera.
--
-- Aquí se hace cumplir en la base, que es donde el DRS quiere que viva la
-- autoridad. Se rechaza la escritura si el `metadata` trae algo que parezca
-- un token del sistema (64 caracteres hexadecimales) o una credencial.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_rechazar_datos_sensibles_auditoria()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_texto TEXT;
BEGIN
    IF NEW.metadata IS NULL THEN
        RETURN NEW;
    END IF;

    v_texto := NEW.metadata::text;

    -- El token del ciudadano son 32 bytes en hexadecimal: 64 caracteres.
    IF v_texto ~ '\m[0-9a-f]{64}\M' THEN
        RAISE EXCEPTION 'auditoria.metadata no puede contener el token de un turno (DRS §11).'
            USING ERRCODE = '22023';
    END IF;

    IF v_texto ~* '(password|contrasena|secret|clave_?privada|authorization)' THEN
        RAISE EXCEPTION 'auditoria.metadata no puede contener credenciales (DRS §11).'
            USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auditoria_sin_datos_sensibles
    BEFORE INSERT ON auditoria
    FOR EACH ROW
    EXECUTE FUNCTION fn_rechazar_datos_sensibles_auditoria();

COMMENT ON FUNCTION fn_rechazar_datos_sensibles_auditoria IS
    'DRS §11: el metadata de la auditoria no puede contener el token de un turno ni credenciales.';

-- ---------------------------------------------------------------------------
-- B. HISTORIAL: inmutable en escritura desde el cliente
-- INSERT lo hacen las RPC; un UPDATE manual falsearía el rastro de transiciones.
-- No se bloquea DELETE porque la cláusula ON DELETE CASCADE de `turnos` debe
-- poder propagarse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bloquear_update_historial()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_dueno TEXT;
BEGIN
    SELECT tableowner INTO v_dueno
      FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'historial_turnos';

    IF current_user IN (COALESCE(v_dueno, 'postgres'), 'service_role', 'supabase_admin') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'historial_turnos no admite UPDATE: registra transiciones ya ocurridas.'
        USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER trg_historial_inmutable
    BEFORE UPDATE ON historial_turnos
    FOR EACH ROW
    EXECUTE FUNCTION fn_bloquear_update_historial();

-- ---------------------------------------------------------------------------
-- C. RETIRADA DE LA SUSCRIPCIÓN PUSH (RF-028, DRS §5.2 paso 6)
-- "Al finalizarse, cancelarse o expirar el turno, su suscripción queda
--  eliminada y no llega ningún aviso posterior."
--
-- ON DELETE CASCADE (001) ya cubre el borrado de la fila del turno; este
-- trigger cubre el caso real, que es un CAMBIO de estado: el turno sigue
-- ahí pero pasa a COMPLETED/CANCELLED/SKIPPED.
--
-- SECURITY DEFINER a propósito: al dispararse, el `UPDATE` de estado puede
-- venir de una RPC que corre como propietario o de un administrador que hace
-- un UPDATE directo. En el segundo caso, `authenticated` no tiene privilegio
-- sobre `suscripciones_push` y sin RLS visible no habría política que le
-- permitiera borrar — el DELETE fallaría o, peor, borraría 0 filas en
-- silencio y el ciudadano seguiría recibiendo avisos de un turno cerrado.
-- Con SECURITY DEFINER corre como el dueño de la tabla, y el dueño no está
-- sujeto a RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_retirar_suscripcion_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM suscripciones_push WHERE token_publico = OLD.token_publico;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_turnos_retirar_suscripcion_push
    AFTER UPDATE OF estado ON turnos
    FOR EACH ROW
    WHEN (NEW.estado IN ('COMPLETED', 'CANCELLED', 'SKIPPED'))
    EXECUTE FUNCTION fn_retirar_suscripcion_push();

COMMENT ON FUNCTION fn_retirar_suscripcion_push IS
    'RF-028: retira la suscripcion push cuando el turno alcanza un estado terminal. SECURITY DEFINER para que el borrado ocurra siempre.';

-- ---------------------------------------------------------------------------
-- D. HABILITAR RLS EN TODAS LAS TABLAS CON DATOS
-- ---------------------------------------------------------------------------

ALTER TABLE apellidos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE modulos             ENABLE ROW LEVEL SECURITY;
ALTER TABLE periodos_operativos ENABLE ROW LEVEL SECURITY;
ALTER TABLE tramites            ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios            ENABLE ROW LEVEL SECURITY;
ALTER TABLE folios              ENABLE ROW LEVEL SECURITY;
ALTER TABLE turnos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE historial_turnos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria           ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracion       ENABLE ROW LEVEL SECURITY;
ALTER TABLE suscripciones_push  ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- E. POLÍTICAS
-- `authenticated` con rol administrativo: todo.
-- `authenticated` sin rol administrativo: solo lectura de catálogos.
-- `anon`: SIN POLÍTICA -> cero filas. Puede ejecutar get_turno_publico()
--         porque esa función es SECURITY DEFINER y corre como su propietario.
-- ---------------------------------------------------------------------------

-- Catálogos y configuración: lectura para cualquiera autenticado.
CREATE POLICY p_lectura ON roles               FOR SELECT TO authenticated USING (true);
CREATE POLICY p_lectura ON apellidos           FOR SELECT TO authenticated USING (true);
CREATE POLICY p_lectura ON tramites            FOR SELECT TO authenticated USING (true);
CREATE POLICY p_lectura ON modulos             FOR SELECT TO authenticated USING (true);
CREATE POLICY p_lectura ON configuracion       FOR SELECT TO authenticated USING (true);

-- Escritura de catálogos: solo administrador.
CREATE POLICY p_admin ON roles               FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());
CREATE POLICY p_admin ON apellidos           FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());
CREATE POLICY p_admin ON tramites            FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());
CREATE POLICY p_admin ON modulos             FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());
CREATE POLICY p_admin ON configuracion       FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());
CREATE POLICY p_admin ON periodos_operativos FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());
CREATE POLICY p_admin ON folios              FOR ALL TO authenticated USING (fn_es_administrador()) WITH CHECK (fn_es_administrador());

-- Turnos: el corazón del sistema (RF-019, RN-008).
CREATE POLICY p_admin_turnos ON turnos
    FOR ALL TO authenticated
    USING (fn_es_administrador())
    WITH CHECK (fn_es_administrador());

-- Historial: lectura administrativa; INSERT solo por RPC.
CREATE POLICY p_admin_historial ON historial_turnos
    FOR SELECT TO authenticated
    USING (fn_es_administrador());

-- Auditoría: SELECT solo para administradores (RF-024: "SELECT según rol").
-- No hay política de INSERT/UPDATE/DELETE -> denegado por defecto.
CREATE POLICY p_select_auditoria ON auditoria
    FOR SELECT TO authenticated
    USING (fn_es_administrador());

-- Usuarios: cada cual ve su propio registro; el administrador ve todos.
CREATE POLICY p_usuarios_propio ON usuarios
    FOR SELECT TO authenticated
    USING (
        auth_uid = auth.uid()
        OR fn_es_administrador()
    );

CREATE POLICY p_usuarios_admin ON usuarios
    FOR ALL TO authenticated
    USING (fn_es_administrador())
    WITH CHECK (fn_es_administrador());

-- Suscripciones push (RF-028): SOLO el administrador las ve desde la consola,
-- para diagnosticar "este ciudadano no recibe avisos".
-- No hay política para `anon` ni para `authenticated` sin rol administrativo:
-- el ciudadano solo puede tocar la tabla a través de
-- registrar_suscripcion_push() / eliminar_suscripcion_push(), que son
-- SECURITY DEFINER y validan el token. Y `suscripciones_por_notificar()` —
-- la única que devolvería endpoints de todo el mundo — está revocada.
CREATE POLICY p_admin_suscripciones ON suscripciones_push
    FOR ALL TO authenticated
    USING (fn_es_administrador())
    WITH CHECK (fn_es_administrador());

-- ---------------------------------------------------------------------------
-- F. PRIVILEGIOS DE NIVEL DE OBJETO
-- En Supabase, `anon`/`authenticated` reciben TODO por defecto y es RLS quien
-- filtra. Aquí se refuerza: `anon` pierde cualquier privilegio directo sobre
-- las tablas base. Su única vía es get_turno_publico().
--
-- CORRECCIÓN DE SEGURIDAD (19-oct-2026): el `REVOKE ... FROM anon` de las
-- funciones NO ERA SUFICIENTE. PostgreSQL concede EXECUTE sobre toda función
-- nueva al pseudo-rol `PUBLIC`, así que `anon` heredaba ese privilegio y podía
-- invocar hasta las RPC administrativas (llamar_siguiente_turno,
-- cerrar_periodo_operativo, asignar_modulo_usuario...). La protección
-- interna de esas RPC (`fn_usuario_actual()` → `auth.uid()`) ya impedía la
-- acción indebida —el anónimo recibía "Sesion invalida"— pero la defensa en
-- profundidad exige que el privilegio no exista. Por eso se revoca a PUBLIC
-- y se concede una por una a quien sí lo necesita.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA public                FROM anon;
        REVOKE ALL ON ALL TABLES IN SCHEMA public  FROM anon;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

        -- 1) Se quita el EXECUTE heredado de PUBLIC sobre las funciones Y el
        --    que `anon` había recibido explícitamente por los privilegios
        --    por defecto de Supabase. Hacen falta las dos revocaciones: la
        --    primera porque PostgreSQL concede EXECUTE a PUBLIC en toda
        --    función nueva, la segunda porque el `ALTER DEFAULT PRIVILEGES`
        --    de Supabase deja una entrada propia en el ACL de `anon`.
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;

        -- 2) Los roles con sesión sí lo necesitan, y de forma amplia: las RPC
        --    administrativas y sus auxiliares.
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

        -- 3) `anon` solo puede usar la consulta pública y las dos RPC de
        --    RF-028. Lo que autoriza en ellas es conocer el token, no haber
        --    iniciado sesión.
        GRANT EXECUTE ON FUNCTION get_turno_publico(TEXT) TO anon;
        GRANT EXECUTE ON FUNCTION registrar_suscripcion_push(TEXT, TEXT, TEXT, TEXT) TO anon;
        GRANT EXECUTE ON FUNCTION eliminar_suscripcion_push(TEXT) TO anon;
        -- RF-033: el titular manifiesta su consideracion con su token.
        GRANT EXECUTE ON FUNCTION manifestar_consideraciones(TEXT, TEXT) TO anon;
        -- RF-020: la pantalla publica, sin cuenta y sin token.
        GRANT EXECUTE ON FUNCTION ultimas_llamadas(INTEGER) TO anon;
        GRANT USAGE ON SCHEMA public TO anon;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT USAGE ON SCHEMA public TO authenticated;
        GRANT SELECT ON
            vista_cola_espera,
            vista_turnos_actuales,
            vista_turnos_retirados,
            vista_seguimiento_turnos,
            vista_historial_turnos,
            vista_estadisticas_tramites
        TO authenticated;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- F bis. LAS DOS RPC DE LA COLA DE AVISOS (RF-028)
--
-- El paso 2 de arriba concede EXECUTE sobre todas las funciones a
-- `authenticated`, y eso deshace la revocación que 004_functions_rpc.sql
-- dejó sobre estas dos. Se vuelven a revocar aquí, ya con la operación de
-- privilegios de este archivo aplicada: son las únicas que verían los
-- `endpoint` de push de todo el mundo.
--
--   * `suscripciones_por_notificar()` — la cola. Devuelve folio, código,
--     módulo y mensaje, NUNCA el token. Solo la usa `/api/push`.
--   * `marcar_aviso_push_enviado(turno_id)` — la marca de entrega.
--   * `eliminar_suscripcion_por_turno(turno_id)` — la limpieza de las
--     suscripciones que el navegador ya no reconoce (404/410 Gone).
--
-- `service_role` las conserva: es quien las necesita (RF-028, DRS §6).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE EXECUTE ON FUNCTION suscripciones_por_notificar() FROM PUBLIC, anon, authenticated;
        REVOKE EXECUTE ON FUNCTION marcar_aviso_push_enviado(UUID) FROM PUBLIC, anon, authenticated;
        REVOKE EXECUTE ON FUNCTION eliminar_suscripcion_por_turno(UUID) FROM PUBLIC, anon, authenticated;
    END IF;
END;
$$;
