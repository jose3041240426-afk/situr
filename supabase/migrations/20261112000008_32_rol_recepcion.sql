-- ===========================================================================
-- 032 — El rol RECEPCIÓN
-- ===========================================================================
--
-- POR QUÉ
-- Se necesita un rol dedicado al personal de recepción con una interfaz
-- simplificada que solo permita tres acciones:
--
--   1. Abrir periodo operativo (con selección de fecha).
--   2. Emitir turnos (reutilizando la lógica existente).
--   3. Consultar los turnos en atención (vista de solo lectura).
--
-- No puede acceder a funciones administrativas (usuarios, catálogos, cierre
-- de jornada) ni a funciones operativas de ventanilla (llamar, atender,
-- cancelar, omitir turnos).
--
-- IMPLEMENTACIÓN
-- Se agrega RECEPCIÓN a la tabla `roles` y se crean las funciones de
-- verificación de permiso que las RPC y políticas RLS usarán.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. El rol en el catálogo
-- ---------------------------------------------------------------------------

INSERT INTO roles (clave, nombre, descripcion)
VALUES (
    'RECEPCION',
    'Personal de recepción',
    'Abre periodos, emite turnos y consulta el estado de atención. '
    'Sin acceso a usuarios, catálogos, cierre de jornada ni gestión operativa de turnos.'
)
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Función de verificación del rol
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_es_recepcion()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM usuarios u
        INNER JOIN roles r ON r.id = u.rol_id
        WHERE u.auth_uid = auth.uid()
          AND u.activo
          AND r.activo
          AND r.clave = 'RECEPCION'
    );
$$;

COMMENT ON FUNCTION fn_es_recepcion() IS
    'True si el usuario autenticado tiene rol RECEPCION activo.';

-- ---------------------------------------------------------------------------
-- 3. Permiso para abrir periodo (RECEPCIÓN + ADMINISTRADOR)
-- ---------------------------------------------------------------------------
--
-- `abrir_periodo_operativo()` usa `fn_es_administrador()` para validar.
-- RECEPCIÓN también debe abrir periodos, pero NO cerrarlos ni administrar
-- catálogos. Por eso se crea esta función separada en lugar de modificar
-- `fn_es_administrador()`.
--
-- La función `abrir_periodo_operativo()` se actualiza para usar esta nueva
-- función en lugar de `fn_es_administrador()`.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_puede_abrir_periodo()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM usuarios u
        INNER JOIN roles r ON r.id = u.rol_id
        WHERE u.auth_uid = auth.uid()
          AND u.activo
          AND r.activo
          AND r.clave IN ('ADMINISTRADOR', 'RECEPCION')
    );
$$;

COMMENT ON FUNCTION fn_puede_abrir_periodo() IS
    'Permite abrir periodos a ADMINISTRADOR y RECEPCION. El cierre de periodo sigue siendo solo ADMINISTRADOR.';

-- ---------------------------------------------------------------------------
-- 4. Actualizar abrir_periodo_operativo() para usar fn_puede_abrir_periodo()
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abrir_periodo_operativo(p_fecha DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_periodo  periodos_operativos%ROWTYPE;
    v_accion   TEXT;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_abrir_periodo() THEN
        RAISE EXCEPTION 'No tiene permiso para abrir periodos.' USING ERRCODE = '42501';
    END IF;

    -- RF-025: "solo uno activo".
    IF EXISTS (SELECT 1 FROM periodos_operativos WHERE estado = 'ABIERTO') THEN
        RAISE EXCEPTION 'Ya existe un periodo operativo abierto (RF-025).'
            USING ERRCODE = 'P0001';
    END IF;

    -- RG-002: una sola jornada por fecha.
    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE clave = p_fecha
       FOR UPDATE;

    IF FOUND THEN
        IF v_periodo.estado = 'ABIERTO' THEN
            RAISE EXCEPTION 'El periodo de esa fecha ya esta abierto (RF-025).'
                USING ERRCODE = 'P0001';
        END IF;

        UPDATE periodos_operativos
           SET estado     = 'ABIERTO',
               cerrado_en = NULL,
               hora_fin   = NULL,
               hora_inicio = COALESCE(hora_inicio, now())
         WHERE id = v_periodo.id
        RETURNING * INTO v_periodo;

        v_accion := 'REABRIR_PERIODO';
    ELSE
        INSERT INTO periodos_operativos (clave, fecha, hora_inicio, estado)
        VALUES (p_fecha, p_fecha, now(), 'ABIERTO')
        RETURNING * INTO v_periodo;

        v_accion := 'ABRIR_PERIODO';
    END IF;

    PERFORM registrar_auditoria(
        v_operador, v_accion, 'periodos_operativos', v_periodo.id::text, 'EXITO',
        jsonb_build_object('clave', v_periodo.clave)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'periodo_id', v_periodo.id,
        'clave', v_periodo.clave,
        'estado', v_periodo.estado,
        'hora_inicio', v_periodo.hora_inicio
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Permiso para generar turnos (RECEPCIÓN + roles existentes)
-- ---------------------------------------------------------------------------
--
-- `generar_turno()` ya solo verifica `fn_usuario_actual()` —cualquier usuario
-- activo autenticado puede emitir—, así que no requiere cambio en la RPC.
-- Sin embargo, para claridad y control futuro, se crea esta función que
-- documenta qué roles pueden emitir turnos.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_puede_emitir_turnos()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM usuarios u
        INNER JOIN roles r ON r.id = u.rol_id
        WHERE u.auth_uid = auth.uid()
          AND u.activo
          AND r.activo
          AND r.clave IN ('ADMINISTRADOR', 'AGENTE', 'RECEPCION')
    );
$$;

COMMENT ON FUNCTION fn_puede_emitir_turnos() IS
    'Permite emitir turnos a ADMINISTRADOR, AGENTE y RECEPCION.';

-- ---------------------------------------------------------------------------
-- 6. Actualizar generar_turno() para validar fn_puede_emitir_turnos()
-- ---------------------------------------------------------------------------
--
-- Se añade la validación de rol dentro de generar_turno() para que RECEPCIÓN
-- pueda emitir pero otros roles futuros (p. ej. SUPERVISOR) no lo hagan por
-- defecto.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION generar_turno(
    p_tramite_id UUID,
    p_prioridad   enum_prioridad_turno DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo   periodos_operativos%ROWTYPE;
    v_tramite   tramites%ROWTYPE;
    v_operador  UUID;
    v_folio     INTEGER;
    v_codigo    TEXT;
    v_token     TEXT;
    v_longitud  INTEGER;
    v_maximo    INTEGER;
    v_prioridad enum_prioridad_turno;
    v_turno_id  UUID;
    v_expira    TIMESTAMPTZ;
    v_result    JSONB;
BEGIN
    -- [1] VALIDA -----------------------------------------------------------
    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto; no se pueden generar turnos (RF-025).'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite
      FROM tramites
     WHERE id = p_tramite_id
       AND activo
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El tramite no existe o esta inactivo.'
            USING ERRCODE = 'P0002';
    END IF;

    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_emitir_turnos() THEN
        RAISE EXCEPTION 'No tiene permiso para emitir turnos.'
            USING ERRCODE = '42501';
    END IF;

    v_prioridad := COALESCE(p_prioridad, v_tramite.prioridad);
    v_longitud  := fn_config_entero('LONGITUD_NUMERO_FOLIO', 3);
    v_maximo    := fn_config_entero('MAXIMO_TURNOS_DIARIOS', 999);

    -- [2] NUMERA -----------------------------------------------------------
    INSERT INTO folios (periodo_operativo_id, tramite_id, ultimo_numero)
    VALUES (v_periodo.id, v_tramite.id, 1)
    ON CONFLICT (periodo_operativo_id, tramite_id)
    DO UPDATE
       SET ultimo_numero  = folios.ultimo_numero + 1,
           actualizado_en = now()
    RETURNING ultimo_numero INTO v_folio;

    IF v_folio > v_maximo THEN
        RAISE EXCEPTION 'Se alcanzo el maximo de turnos diarios (%) para este tramite.', v_maximo
            USING ERRCODE = 'P0001';
    END IF;

    v_codigo := v_tramite.prefijo || '-' || lpad(v_folio::text, v_longitud, '0');

    -- [3] ASEGURA ----------------------------------------------------------
    v_token := encode(gen_random_bytes(32), 'hex');

    -- [4] EXPIRA -----------------------------------------------------------
    v_expira := calcular_expiracion_token('WAITING');

    -- [5] PERSISTE ---------------------------------------------------------
    INSERT INTO turnos (
        folio, codigo, periodo_operativo_id, tramite_id, modulo_id,
        estado, prioridad, token_publico, token_expira_en,
        tiempo_estimado_mostrado_minutos
    ) VALUES (
        v_folio, v_codigo, v_periodo.id, v_tramite.id, NULL,
        'WAITING', v_prioridad, v_token, v_expira,
        v_tramite.tiempo_estimado_minutos
    )
    RETURNING id INTO v_turno_id;

    -- [6] TRAZA ------------------------------------------------------------
    PERFORM registrar_historial(
        v_turno_id, NULL, 'WAITING', v_operador, NULL,
        'Turno generado por el sistema.',
        jsonb_build_object('periodo', v_periodo.clave, 'folio', v_folio)
    );

    PERFORM registrar_auditoria(
        v_operador, 'GENERAR_TURNO', 'turnos', v_turno_id::text, 'EXITO',
        jsonb_build_object('tramite', v_tramite.clave, 'codigo', v_codigo)
    );

    -- [7] EMITE ------------------------------------------------------------
    SELECT jsonb_build_object(
        'ok',                true,
        'turno_id',            t.id,
        'codigo_turno',        t.codigo,
        'folio',               t.folio,
        'clave_tramite',       tr.clave,
        'denominacion_tramite',tr.denominacion,
        'estado',              t.estado,
        'prioridad',           t.prioridad,
        'periodo',             p.clave,
        'creado_en',           t.creado_en,
        'token_publico',       t.token_publico,
        'token_expira_en',     t.token_expira_en,
        'tiempo_estimado_minutos', t.tiempo_estimado_mostrado_minutos
    ) INTO v_result
    FROM turnos t
    INNER JOIN tramites tr           ON tr.id = t.tramite_id
    INNER JOIN periodos_operativos p ON p.id  = t.periodo_operativo_id
    WHERE t.id = v_turno_id;

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Políticas RLS para RECEPCIÓN
-- ---------------------------------------------------------------------------
--
-- RECEPCIÓN necesita:
--   - Leer periodos_operativos (ya lo permite p_lectura_periodos si existe,
--     o se añade una política específica).
--   - Insertar en periodos_operativos (abrir periodo).
--   - Leer tramites y modulos (ya permitido para authenticated).
--   - Leer vista_turnos_actuales (ya permitido para authenticated).
--   - Insertar en turnos y folios (lo hace generar_turno() como SECURITY DEFINER).
--
-- La política de periodos_operativos actual (p_admin) usa fn_es_administrador()
-- para ALL operaciones. Se añade una política específica para RECEPCIÓN que
-- permite SELECT e INSERT (pero no UPDATE/DELETE de cierre).
-- ---------------------------------------------------------------------------

-- RECEPCIÓN puede leer periodos
CREATE POLICY p_recepcion_periodos_select
    ON periodos_operativos
    FOR SELECT
    TO authenticated
    USING (fn_es_recepcion());

-- RECEPCIÓN puede insertar periodos (abrir periodo)
CREATE POLICY p_recepcion_periodos_insert
    ON periodos_operativos
    FOR INSERT
    TO authenticated
    WITH CHECK (fn_es_recepcion());

-- ---------------------------------------------------------------------------
-- 8. Política para que RECEPCIÓN pueda leer turnos (solo lectura)
-- ---------------------------------------------------------------------------
--
-- La política p_admin_turnos ya da ALL a fn_es_administrador().
-- RECEPCIÓN solo necesita SELECT para ver la cola y los turnos en atención.
-- Las vistas (vista_turnos_actuales, vista_cola_espera) ya conceden SELECT
-- a authenticated, así que la lectura de vistas funciona sin política extra.
-- Pero para que generar_turno() pueda INSERT en turnos, la RPC ya usa
-- SECURITY DEFINER, así que no necesita política directa.
-- ---------------------------------------------------------------------------

-- RECEPCIÓN puede leer turnos (para ver el estado de emisión)
CREATE POLICY p_recepcion_turnos_select
    ON turnos
    FOR SELECT
    TO authenticated
    USING (fn_es_recepcion());

-- RECEPCIÓN puede insertar turnos (emisión)
CREATE POLICY p_recepcion_turnos_insert
    ON turnos
    FOR INSERT
    TO authenticated
    WITH CHECK (fn_es_recepcion());

-- RECEPCIÓN puede insertar folios (emisión)
CREATE POLICY p_recepcion_folios
    ON folios
    FOR ALL
    TO authenticated
    USING (fn_es_recepcion())
    WITH CHECK (fn_es_recepcion());

-- ---------------------------------------------------------------------------
-- 9. RECEPCIÓN puede leer historial_turnos (para auditoría básica)
-- ---------------------------------------------------------------------------

CREATE POLICY p_recepcion_historial_select
    ON historial_turnos
    FOR SELECT
    TO authenticated
    USING (fn_es_recepcion());
