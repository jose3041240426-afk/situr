-- ============================================================================
-- SITUR — MIGRACIÓN 004: FUNCIONES RPC
-- Modelo de datos FUSIONADO v2.0
--
-- Filosofía (idéntica a la Figura 15 del DRS): "React pide, PostgreSQL
-- decide". Toda mutación ocurre aquí, dentro de una transacción, con
-- historial + auditoría ANTES de que la transacción se confirme.
--
-- DIFERENCIAS CLAVE FRENTE A LOS PROCEDIMIENTOS DE TOMA_TURNO
--
--  1. SEGURIDAD (corrección del hueco más grave de TOMA_TURNO).
--     TOMA_TURNO aceptaba `p_usuario_id` como parámetro enviado por el cliente
--     y solo verificaba que existiera: cualquier cuenta podía llamar turnos
--     desde cualquier ventanilla. Aquí el operador NO se pasa como parámetro:
--     se deriva de auth.uid() dentro de la función. RN-007 queda garantizado
--     por la base, no por el frontend.
--
--  2. CONCURRENCIA (portado de TOMA_TURNO, que aquí estaba bien resuelto).
--     Se conserva `FOR UPDATE SKIP LOCKED` para que dos módulos no se peleen
--     el mismo turno, y el contador atómico de folios.
--
--  3. TODOS los parámetros numéricos vienen de la tabla `configuracion`
--     (portada de TOMA_TURNO). Corregido el bug original: allí
--     MAXIMO_NUMERO_DIARIO existía en configuracion pero el procedimiento
--     validaba `> 999` escrito a mano.
--
--  4. Transiciones validadas contra la máquina de estados de la Figura 6
--     (RN-011) mediante fn_transicion_valida(): ninguna función puede sacar un
--     turno de un estado terminal.
--
-- NOTA DE DESPLIEGUE: estas funciones usan auth.uid() de Supabase Auth. Para
-- probarlas en PostgreSQL local véase prueba/00_stubs.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- AUXILIARES
-- ---------------------------------------------------------------------------

-- RN-007: quién es el operador actual. Nunca se recibe desde el cliente.
CREATE OR REPLACE FUNCTION fn_usuario_actual()
RETURNS UUID
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.id
    FROM usuarios u
    WHERE u.auth_uid = auth.uid()
      AND u.activo
    LIMIT 1;
$$;

COMMENT ON FUNCTION fn_usuario_actual() IS
    'Resuelve el operador a partir de auth.uid(). El usuario nunca se pasa como parametro.';

-- RN-007: el que ejecuta debe tener rol administrador o supervisor activo.
CREATE OR REPLACE FUNCTION fn_es_administrador()
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
          AND r.clave IN ('ADMINISTRADOR', 'SUPERVISOR')
    );
$$;

COMMENT ON FUNCTION fn_es_administrador() IS
    'True si el usuario autenticado tiene rol ADMINISTRADOR o SUPERVISOR activo. Usada por RLS y por las operaciones de catálogo y periodo.';

-- RN-007 variante para OPERAR turnos (llamar, iniciar, finalizar, cancelar,
-- omitir, repetir).
--
-- Se separa de fn_es_administrador() por una razón concreta: RF-002 solo
-- siembra ADMINISTRADOR y SUPERVISOR en el MVP, pero la tabla `roles` permite
-- añadir AGENTE (el "TRABAJADOR" de TOMA_TURNO) con un INSERT y sin migrar el
-- esquema. Con una sola función de permisos, agregar ese rol obligaría a
-- reimplementar seis funciones; con dos, solo hay que sumarlo a esta lista.
--
-- Como AGENTE hoy no existe en los datos sembrados, el comportamiento en MVP
-- es idéntico al de la lista original.
CREATE OR REPLACE FUNCTION fn_puede_operar_turnos()
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
          AND r.clave IN ('ADMINISTRADOR', 'AGENTE')
    );
$$;

COMMENT ON FUNCTION fn_puede_operar_turnos() IS
    'Permisos para operar turnos: ADMINISTRADOR y AGENTE. SUPERVISOR NO opera: el DRS §3 lo define como rol de supervision (estadisticas, historial, parametros) y no de operacion, y en el MVP ni siquiera esta en uso. Que el permiso este escrito en la base y no solo en el documento es lo que permite que un rol de mas pueda dejar de hacerlo con un UPDATE.';

-- Intento denegado (RN-007 / RN-016).
--
-- Devuelve un resultado en vez de lanzar una excepción, y eso es deliberado:
-- en PostgreSQL un RAISE dentro de una función revierte TODA la transacción,
-- borrando el propio registro de auditoría que acaba de escribirse. Para que
-- un intento denegado quede registrado tiene que salir con RETURN, no con
-- RAISE. Los errores de validación (turno inexistente, transición ilegal)
-- sí usan RAISE, porque ahí no interesa conservar nada.
CREATE OR REPLACE FUNCTION fn_denegar(
    p_accion     TEXT,
    p_entidad    TEXT,
    p_entidad_id TEXT,
    p_usuario_id UUID,
    p_motivo     TEXT,
    p_detalle    JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM registrar_auditoria(
        p_usuario_id, p_accion, p_entidad, p_entidad_id, 'DENEGADO',
        COALESCE(p_detalle, '{}'::jsonb) || jsonb_build_object('motivo', p_motivo)
    );

    RETURN jsonb_build_object(
        'ok',        false,
        'resultado', 'DENEGADO',
        'error',     p_motivo
    );
END;
$$;

COMMENT ON FUNCTION fn_denegar IS
    'Registra un intento denegado en auditoria y lo devuelve como resultado. Usa RETURN y no RAISE porque un RAISE revertiria el propio registro.';

-- Lectura de parámetros. PORTADO DE TOMA_TURNO y corregido: valida tipo.
CREATE OR REPLACE FUNCTION fn_config_texto(p_clave TEXT, p_defecto TEXT DEFAULT NULL)
RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT c.valor FROM configuracion c
          WHERE c.clave = p_clave AND c.activo),
        p_defecto
    );
$$;

CREATE OR REPLACE FUNCTION fn_config_entero(p_clave TEXT, p_defecto INTEGER DEFAULT 0)
RETURNS INTEGER
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_valor TEXT;
BEGIN
    v_valor := fn_config_texto(p_clave, p_defecto::text);
    RETURN v_valor::integer;
EXCEPTION
    WHEN invalid_text_representation THEN
        RAISE WARNING 'configuracion.% no es ENTERO; se usa el defecto %', p_clave, p_defecto;
        RETURN p_defecto;
END;
$$;

-- Ciclo de vida del token (DRS §9).
--   WAITING/CALLED/SERVING -> activo
--   COMPLETED              -> 24 h
--   CANCELLED/SKIPPED      -> 1 h
-- Los valores viven en `configuracion` para que Catastro pueda cambiarlos sin
-- desplegar código (RF-023).
CREATE OR REPLACE FUNCTION calcular_expiracion_token(p_estado enum_estado_turno)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_estado
        WHEN 'COMPLETED' THEN
            now() + (fn_config_entero('HORAS_VIGENCIA_TOKEN_ATENDIDO', 24) || ' hours')::interval
        WHEN 'CANCELLED' THEN
            now() + (fn_config_entero('HORAS_VIGENCIA_TOKEN_CERRADO', 1) || ' hours')::interval
        WHEN 'SKIPPED'   THEN
            now() + (fn_config_entero('HORAS_VIGENCIA_TOKEN_CERRADO', 1) || ' hours')::interval
        ELSE
            -- WAITING / CALLED / SERVING: activo hasta el cierre de la jornada.
            now() + (fn_config_entero('MINUTOS_VIGENCIA_TOKEN_EN_ESPERA', 1440) || ' minutes')::interval
    END;
$$;

-- RN-011 / RN-004 / RN-006: la máquina de estados de la Figura 6, literal.
-- Es la única fuente de verdad de qué transición está permitida.
CREATE OR REPLACE FUNCTION fn_transicion_valida(
    p_desde enum_estado_turno,
    p_hacia enum_estado_turno
)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT (p_desde, p_hacia) IN (
        ('WAITING',   'CALLED'),
        ('WAITING',   'CANCELLED'),
        ('WAITING',   'SKIPPED'),
        ('CALLED',    'SERVING'),
        ('CALLED',    'SKIPPED'),
        ('SERVING',   'COMPLETED')
    );
$$;

COMMENT ON FUNCTION fn_transicion_valida IS
    'Devuelve TRUE solo si la transicion existe en el diagrama 6. No hay flecha de vuelta desde COMPLETED/CANCELLED/SKIPPED.';

-- Traza. RN-015 (historial) y RN-016 (auditoría).
CREATE OR REPLACE FUNCTION registrar_historial(
    p_turno_id   UUID,
    p_anterior   enum_estado_turno,
    p_nuevo      enum_estado_turno,
    p_usuario_id UUID,
    p_modulo_id  UUID,
    p_motivo     TEXT DEFAULT NULL,
    p_metadata   JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO historial_turnos
        (turno_id, estado_anterior, estado_nuevo, usuario_id, modulo_id, motivo, metadata)
    VALUES
        (p_turno_id, p_anterior, p_nuevo, p_usuario_id, p_modulo_id, p_motivo, p_metadata);
$$;

CREATE OR REPLACE FUNCTION registrar_auditoria(
    p_usuario_id UUID,
    p_accion     TEXT,
    p_entidad    TEXT,
    p_entidad_id TEXT,
    p_resultado  enum_resultado_auditoria DEFAULT 'EXITO',
    p_metadata   JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO auditoria
        (usuario_id, accion, entidad, entidad_id, resultado, metadata)
    VALUES
        (p_usuario_id, p_accion, p_entidad, p_entidad_id, p_resultado, p_metadata);
$$;

-- ---------------------------------------------------------------------------
-- RPC 01: GENERAR TURNO
-- Figura 13 — las 7 etapas: valida, numera, asegura, expira, persiste, traza,
-- emite.
-- El paso 2 es la pieza PORTADA DE TOMA_TURNO que cerró la laguna de RN-003.
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
    -- Solo se emiten turnos dentro de un periodo abierto (RG-002, RF-025).
    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto; no se pueden generar turnos (RF-025).'
            USING ERRCODE = 'P0001';
    END IF;

    -- FOR SHARE: congela el trámite mientras se numerar su consecutivo.
    SELECT * INTO v_tramite
      FROM tramites
     WHERE id = p_tramite_id
       AND activo
       FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El tramite no existe o esta inactivo.'
            USING ERRCODE = 'P0002';
    END IF;

    -- El operador debe existir y estar activo (RN-007).
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    v_prioridad := COALESCE(p_prioridad, v_tramite.prioridad);
    v_longitud  := fn_config_entero('LONGITUD_NUMERO_FOLIO', 3);
    v_maximo    := fn_config_entero('MAXIMO_TURNOS_DIARIOS', 999);

    -- [2] NUMERA -----------------------------------------------------------
    -- Contador atómico por (periodo, trámite). Un solo statement = un solo
    -- bloqueo de fila, por lo que dos ventanillas que emitan a la vez obtienen
    -- números distintos. Esto es lo que el DRS no especificaba.
    INSERT INTO folios (periodo_operativo_id, tramite_id, ultimo_numero)
    VALUES (v_periodo.id, v_tramite.id, 1)
    ON CONFLICT (periodo_operativo_id, tramite_id)
    DO UPDATE
       SET ultimo_numero  = folios.ultimo_numero + 1,
           actualizado_en = now()
    RETURNING ultimo_numero INTO v_folio;

    -- Lee el máximo de configuración (bug de TOMA_TURNO: estaba hardcodeado
    -- en 999 en el procedimiento pese a existir la clave en su tabla).
    IF v_folio > v_maximo THEN
        RAISE EXCEPTION 'Se alcanzo el maximo de turnos diarios (%) para este tramite.', v_maximo
            USING ERRCODE = 'P0001';
    END IF;

    -- Código visible: prefijo globalmente único + consecutivo con relleno.
    v_codigo := v_tramite.prefijo || '-' || lpad(v_folio::text, v_longitud, '0');

    -- [3] ASEGURA ----------------------------------------------------------
    -- 32 bytes = 256 bits de entropía, muy por encima de los 128 bits (RN-010).
    -- El código visible y el token jamás se derivan el uno del otro.
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
    -- Antes de confirmar: si algo falla, se revierte todo (Figura 8, paso 6).
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

COMMENT ON FUNCTION generar_turno IS
    'Figura 13. Emite un turno: valida, numera (contador atomico portado de TOMA_TURNO), asegura token de 256 bits, expira, persiste, traza y emite.';

-- ---------------------------------------------------------------------------
-- RPC 02: LLAMAR SIGUIENTE TURNO
-- La operación crítica (RN-009, Figura 8).
--
-- Portado de TOMA_TURNO: `FOR UPDATE SKIP LOCKED`, que es exactamente lo que
-- evita que dos módulos reciban el mismo turno.
-- Corregido: TOMA_TURNO no comprobaba que el operador estuviera asignado a la
-- ventanilla desde la que llamaba.
-- ---------------------------------------------------------------------------
-- Criterio de elegibilidad: por defecto se mira la cola COMPLETA del periodo y
-- se ordena por RN-017 (URGENTE > PREFERENTE > NORMAL, desempate creado_en,
-- id). Ese es el orden global.
--
-- AMBIGÜEDAD DEL DRS RESUELTA AQUÍ (ver REPORTE_FUSION, apartado 4):
-- RN-017 ordena la cola de forma global, mientras que RN-014 dice que la
-- posición que ve el ciudadano es "por trámite+periodo". Si se llama en orden
-- global y se informa posición por trámite, la cifra puede no coincidir con el
-- orden real. Por eso el parámetro `p_tramite_id` acota la cola a un trámite
-- cuando el frente lo necesita: con él, el orden de llamado y la posición
-- informada quedan en el mismo ámbito. Con NULL se mantiene el orden global.
CREATE OR REPLACE FUNCTION llamar_siguiente_turno(
    p_modulo_id  UUID DEFAULT NULL,
    p_tramite_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador    usuarios%ROWTYPE;
    v_modulo_id   UUID;
    v_modulo      modulos%ROWTYPE;
    v_periodo     periodos_operativos%ROWTYPE;
    v_turno       turnos%ROWTYPE;
    v_tramite     tramites%ROWTYPE;
    v_ocupado     BOOLEAN;
    v_result      JSONB;
BEGIN
    -- [1] Operador autenticado y activo. NO viene como parámetro (fix de
    --     seguridad sobre TOMA_TURNO).
    SELECT * INTO v_operador FROM usuarios WHERE id = fn_usuario_actual();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RETURN fn_denegar('LLAMAR_SIGUIENTE', 'turnos', NULL, v_operador.id,
                          'Rol sin permiso para llamar turnos (RN-007).');
    END IF;

    -- [2] Elegir módulo según RG-004.
    --     Se pidió módulo explícito -> se usa (debe estar operativo).
    --     No se pidió -> el módulo del operador si está ACTIVO.
    --     Sin módulo o inactivo -> cualquier módulo ACTIVO.
    v_modulo_id := p_modulo_id;

    IF v_modulo_id IS NULL AND v_operador.modulo_id IS NOT NULL THEN
        SELECT m.id INTO v_modulo_id
          FROM modulos m
         WHERE m.id = v_operador.modulo_id
           AND m.estado = 'ACTIVO'
           AND m.activo;
    END IF;

    IF v_modulo_id IS NULL THEN
        SELECT m.id INTO v_modulo_id
          FROM modulos m
         WHERE m.estado = 'ACTIVO' AND m.activo
         ORDER BY m.codigo
         LIMIT 1;
    END IF;

    IF v_modulo_id IS NULL THEN
        RAISE EXCEPTION 'No hay ningun modulo operativo disponible (RN-013).'
            USING ERRCODE = 'P0001';
    END IF;

    -- [3] Bloquear el módulo: serializa los llamados del mismo módulo y
    --     permite el chequeo "¿sigue ocupado?" sin ventana de carrera.
    SELECT * INTO v_modulo FROM modulos WHERE id = v_modulo_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El modulo no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_modulo.activo OR v_modulo.estado <> 'ACTIVO' THEN
        RAISE EXCEPTION 'El modulo % no esta operativo (estado %).',
            v_modulo.codigo, v_modulo.estado USING ERRCODE = 'P0001';
    END IF;

    -- [4] ¿El operador está asignado a este módulo?
    --     Corrección directa del hueco de TOMA_TURNO.
    IF v_operador.modulo_id IS DISTINCT FROM v_modulo.id
       AND v_operador.rol_id <> (
            SELECT id FROM roles WHERE clave = 'ADMINISTRADOR'
       ) THEN
        RETURN fn_denegar(
            'LLAMAR_SIGUIENTE', 'turnos', NULL, v_operador.id,
            format('El operador %s no esta asignado al modulo %s.',
                   v_operador.numero_empleado, v_modulo.codigo),
            jsonb_build_object('modulo', v_modulo.codigo,
                               'operador', v_operador.numero_empleado)
        );
    END IF;

    -- [5] Ningún turno en curso en este módulo.
    SELECT EXISTS (
        SELECT 1 FROM turnos
         WHERE modulo_id = v_modulo.id
           AND estado IN ('CALLED', 'SERVING')
    ) INTO v_ocupado;

    IF v_ocupado THEN
        RAISE EXCEPTION 'El modulo % todavia tiene un turno en atencion.', v_modulo.codigo
            USING ERRCODE = 'P0001';
    END IF;

    -- [6] Periodo abierto.
    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto.' USING ERRCODE = 'P0001';
    END IF;

    -- [7] SIGUIENTE TURNO, con orden RN-017 y bloqueo SKIP LOCKED.
    --     Si otro módulo está tomando esa misma fila, no espera: pasa a la
    --     siguiente. Ese es el aporte concreto de TOMA_TURNO.
    SELECT * INTO v_turno
      FROM turnos
     WHERE periodo_operativo_id = v_periodo.id
       AND estado = 'WAITING'
       AND (p_tramite_id IS NULL OR tramite_id = p_tramite_id)
     ORDER BY
        CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
        creado_en,
        id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existen turnos pendientes para el periodo actual.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    -- [8] Transición válida (RN-011).
    IF NOT fn_transicion_valida(v_turno.estado, 'CALLED') THEN
        RAISE EXCEPTION 'Transicion % -> CALLED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    -- [9] Efectuar.
    UPDATE turnos
       SET estado        = 'CALLED',
           modulo_id     = v_modulo.id,
           atendido_por  = v_operador.id,
           llamado_en    = now(),
           numero_llamadas = numero_llamadas + 1,
           token_expira_en = calcular_expiracion_token('CALLED')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, 'WAITING', 'CALLED', v_operador.id, v_modulo.id,
        'Turno llamado por el operador.',
        jsonb_build_object('numero_llamada', v_turno.numero_llamadas + 1)
    );

    PERFORM registrar_auditoria(
        v_operador.id, 'LLAMAR_SIGUIENTE', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('modulo', v_modulo.codigo, 'codigo', v_turno.codigo)
    );

    -- [10] Resultado (Figura 8, paso 7: Realtime notifica después del COMMIT).
    SELECT jsonb_build_object(
        'ok',                true,
        'turno_id',           t.id,
        'codigo_turno',       t.codigo,
        'folio',              t.folio,
        'clave_tramite',      tr.clave,
        'denominacion_tramite', tr.denominacion,
        'codigo_modulo',      m.codigo,
        'denominacion_modulo', m.denominacion,
        'estado',             t.estado,
        'prioridad',          t.prioridad,
        'llamado_en',         t.llamado_en,
        'numero_llamadas',    t.numero_llamadas,
        'operador',           u.numero_empleado
    ) INTO v_result
    FROM turnos t
    INNER JOIN tramites tr ON tr.id = t.tramite_id
    INNER JOIN modulos  m  ON m.id  = t.modulo_id
    INNER JOIN usuarios u  ON u.id  = t.atendido_por
    WHERE t.id = v_turno.id;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION llamar_siguiente_turno IS
    'Figura 8. FOR UPDATE SKIP LOCKED (portado de TOMA_TURNO) + orden RN-017. Corrige que TOMA_TURNO no validara el operador contra la ventanilla.';

-- ---------------------------------------------------------------------------
-- RPC 02 bis: PROPONER EL SIGUIENTE TURNO (P5 — proponer, luego ejecutar)
--
-- La función de arriba llama a un turno y devuelve cuál fue. El operador se
-- enteraba DESPUÉS de apretar. Con esta, el operador ve ANTES lo que el
-- sistema va a hacer, y con la razón.
--
-- La regla que la hace útil: usa EXACTAMENTE el mismo filtro y el mismo
-- ORDER BY que `llamar_siguiente_turno()`. Si las dos se separaran, la
-- propuesta le mentiría al operador, que es peor que no proponer nada.
--
-- No bloquea filas ni cambia estados: es una lectura. Puede quedar
-- desactualizada entre que se propone y se llama, y eso es honesto: el
--atto real sigue siendo el de `llamar_siguiente_turno()`, que es atómico.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION proponer_siguiente_turno(
    p_modulo_id UUID DEFAULT NULL,
    p_tramite_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo     UUID;
    v_turno       turnos%ROWTYPE;
    v_tramite     tramites%ROWTYPE;
    v_pos_global  INTEGER;
    v_urgentes    INTEGER;
    v_preferentes INTEGER;
    v_en_espera   INTEGER;
    v_minutos     INTEGER;
    v_razon       TEXT;
BEGIN
    IF fn_usuario_actual() IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_turno
      FROM turnos
     WHERE periodo_operativo_id = v_periodo
       AND estado = 'WAITING'
       AND (p_tramite_id IS NULL OR tramite_id = p_tramite_id)
     ORDER BY
        CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
        creado_en,
        id
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', true, 'hay_turnos', false,
            'mensaje', 'No hay turnos en espera en este periodo.'
        );
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    -- El resto de la cola, para decir POR QUÉ sale este y no otro.
    SELECT
        count(*) FILTER (WHERE prioridad = 'URGENTE'),
        count(*) FILTER (WHERE prioridad = 'PREFERENTE'),
        count(*)
      INTO v_urgentes, v_preferentes, v_en_espera
      FROM turnos
     WHERE periodo_operativo_id = v_periodo
       AND estado = 'WAITING'
       AND (p_tramite_id IS NULL OR tramite_id = p_tramite_id);

    SELECT posicion_global INTO v_pos_global
      FROM vista_cola_espera
     WHERE turno_id = v_turno.id;

    v_minutos := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_turno.creado_en)) / 60)::INTEGER;

    -- La razón, en lenguaje llano. Es la diferencia entre un sello de goma y
    -- un juicio: el operador puede leer y estar de acuerdo o no.
    v_razon := CASE
        WHEN v_turno.prioridad = 'URGENTE' AND v_urgentes = 1
            THEN 'Es el unico turno urgente de la cola: sale primero.'
        WHEN v_turno.prioridad = 'URGENTE'
            THEN 'Es urgente y hay ' || v_urgentes || ' urgentes: sale primero por prioridad.'
        WHEN v_turno.prioridad = 'PREFERENTE'
            THEN 'Turno preferente (los normales esperan detrás).'
        WHEN v_en_espera = 1
            THEN 'Es el unico turno en espera.'
        ELSE 'Lleva ' || v_minutos || ' min esperando: es el mas antiguo de los '
                 || v_en_espera || ' en cola.'
    END;

    RETURN jsonb_build_object(
        'ok',                    true,
        'hay_turnos',            true,
        'turno_id',              v_turno.id,
        'codigo_turno',          v_turno.codigo,
        'folio',                 v_turno.folio,
        'clave_tramite',         v_tramite.clave,
        'denominacion_tramite',  v_tramite.denominacion,
        'prioridad',             v_turno.prioridad,
        'posicion_global',       v_pos_global,
        'en_espera',             v_en_espera,
        'minutos_esperando',     v_minutos,
        'razon',                 v_razon
    );
END;
$$;

COMMENT ON FUNCTION proponer_siguiente_turno IS
    'P5: la propuesta que el operador aprueba antes de llamar. Mismo filtro y mismo ORDER BY que llamar_siguiente_turno(), mas la razon.';

-- ---------------------------------------------------------------------------
-- RPC 02 ter: LLAMAR A UN TURNO CONCRETO (P10 — redirigir)
--
-- `llamar_siguiente_turno()` solo sabe llamar al siguiente. Si el operador
-- ve en la cola a alguien a quien no le toca todavia (una urgencia de otro
-- tramite que entra por otra via, o simplemente un criterio de ventanilla),
-- la unica manera de "corregir" era omitir al llamado: es decir, quemar el
-- turno de ese ciudadano para llegar al que si queria.
--
-- Esta RPC permite REDIRIGIR: llamar a un turno concreto de la cola, sin
-- tocar los demas. Es la diferencia entre "aceptar todo o abandonar" y
-- "arreglar el 30% en su sitio".
--
-- El estado sigue transitioning por la maquina de estados (RN-011) y el
-- bloqueo sigue siendo de fila (RN-009): si otro modulo se lleva a este
-- turno entre la vista y la llamada, aqui se rechaza.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION llamar_turno(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo   periodos_operativos%ROWTYPE;
    v_turno     turnos%ROWTYPE;
    v_modulo    modulos%ROWTYPE;
    v_operador  usuarios%ROWTYPE;
    v_result    JSONB;
BEGIN
    SELECT * INTO v_operador
      FROM usuarios
     WHERE id = fn_usuario_actual();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RETURN fn_denegar('LLAMAR_TURNO', 'turnos', p_turno_id::text, v_operador.id,
            'Rol sin permiso para llamar turnos (RN-007).');
    END IF;

    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto.' USING ERRCODE = 'P0001';
    END IF;

    -- Bloqueo de fila: si otro modulo se lleva este turno ahora mismo, aqui
    -- se detecta (SKIP LOCKED no aplica: aqui se QUIERE esperar).
    SELECT * INTO v_turno
      FROM turnos
     WHERE id = p_turno_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.estado <> 'WAITING' THEN
        RAISE EXCEPTION 'El turno % ya no esta en espera (estado %).',
            v_turno.codigo, v_turno.estado USING ERRCODE = 'P0001';
    END IF;

    IF v_turno.periodo_operativo_id <> v_periodo.id THEN
        RAISE EXCEPTION 'El turno pertenece a otro periodo operativo.'
            USING ERRCODE = 'P0001';
    END IF;

    IF NOT fn_transicion_valida(v_turno.estado, 'CALLED') THEN
        RAISE EXCEPTION 'Transicion % -> CALLED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    -- Modulo: el del operador si esta ACTIVO (RG-004), si no, el primero activo.
    SELECT * INTO v_modulo
      FROM modulos
     WHERE id = v_operador.modulo_id
       AND estado = 'ACTIVO'
       AND activo;
    IF NOT FOUND THEN
        SELECT * INTO v_modulo
          FROM modulos
         WHERE estado = 'ACTIVO' AND activo
         ORDER BY codigo
         LIMIT 1;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay modulos activos (RN-013).' USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos
       SET estado           = 'CALLED',
           modulo_id        = v_modulo.id,
           atendido_por     = v_operador.id,
           llamado_en       = now(),
           numero_llamadas  = numero_llamadas + 1,
           token_expira_en  = calcular_expiracion_token('CALLED')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, 'WAITING', 'CALLED', v_operador.id, v_modulo.id,
        'Turno llamado de forma dirigida por el operador.',
        jsonb_build_object('numero_llamada', v_turno.numero_llamadas + 1,
                           'llamada_dirigida', true)
    );

    PERFORM registrar_auditoria(
        v_operador.id, 'LLAMAR_TURNO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('modulo', v_modulo.codigo, 'codigo', v_turno.codigo)
    );

    SELECT jsonb_build_object(
        'ok',                true,
        'turno_id',           t.id,
        'codigo_turno',       t.codigo,
        'folio',              t.folio,
        'clave_tramite',      tr.clave,
        'denominacion_tramite', tr.denominacion,
        'codigo_modulo',      m.codigo,
        'denominacion_modulo', m.denominacion,
        'estado',             t.estado,
        'prioridad',          t.prioridad,
        'llamado_en',         t.llamado_en,
        'numero_llamadas',    t.numero_llamadas,
        'operador',           u.numero_empleado
    ) INTO v_result
    FROM turnos t
    INNER JOIN tramites tr ON tr.id = t.tramite_id
    INNER JOIN modulos  m  ON m.id  = t.modulo_id
    INNER JOIN usuarios u  ON u.id  = t.atendido_por
    WHERE t.id = v_turno.id;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION llamar_turno IS
    'P10: redirigir la llamada a un turno concreto de la cola, sin omitir ni quemar los demas.';

-- ---------------------------------------------------------------------------
-- RPC 02 quater: REPONER UN TURNO (P12 — el carril de recurso)
--
-- El mensaje que ve el ciudadano cuando su turno se omite dice: "Su turno no
-- fue atendido. Acuda a ventanilla para reposicion." Ese mensaje promete un
-- recurso... que el operador no tenia forma de ofrecer. Este es el recurso.
--
-- Un turno SKIPPED o CANCELLED no se reactiva (RN-006: la maquina de estados
-- no tiene flecha de vuelta). Lo que se hace es EMITIR UN TURNO NUEVO para el
-- mismo tramite y el mismo periodo, con su propio folio y su propio token, y
-- dejar el enlace con el original en la auditoria y el historial.
--
-- Es deliberadamente un turno NUEVO y no una reactivacion: el token del
-- original caduca, la maquina de estados no se toca, y la traza queda
-- completa. Lo que cambia es que ahora existe la herramienta que el mensaje
-- del ciudadano promete.
--
-- La prioridad se conserva: el ciudadano no pierde su lugar por un error del
-- operador.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reponer_turno(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo   periodos_operativos%ROWTYPE;
    v_original  turnos%ROWTYPE;
    v_tramite   tramites%ROWTYPE;
    v_operador  usuarios%ROWTYPE;
    v_folio     INTEGER;
    v_codigo    TEXT;
    v_token     TEXT;
    v_longitud  INTEGER;
    v_maximo    INTEGER;
    v_turno_id  UUID;
    v_expira    TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_operador
      FROM usuarios
     WHERE id = fn_usuario_actual();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RETURN fn_denegar('REPONER_TURNO', 'turnos', p_turno_id::text, v_operador.id,
            'Rol sin permiso para reponer turnos (RN-007).');
    END IF;

    SELECT * INTO v_original FROM turnos WHERE id = p_turno_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_original.estado NOT IN ('SKIPPED', 'CANCELLED') THEN
        RAISE EXCEPTION 'Solo se puede reponer un turno omitido o cancelado (estado %).',
            v_original.estado USING ERRCODE = 'P0001';
    END IF;

    -- El periodo del original tiene que seguir abierto: la reposicion es
    -- dentro de la misma jornada.
    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE id = v_original.periodo_operativo_id;
    IF NOT FOUND OR v_periodo.estado <> 'ABIERTO' THEN
        RAISE EXCEPTION 'El periodo del turno ya no esta abierto; no se puede reponer.'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_original.tramite_id;
    IF NOT FOUND OR NOT v_tramite.activo THEN
        RAISE EXCEPTION 'El tramite del turno ya no esta disponible.' USING ERRCODE = 'P0002';
    END IF;

    v_longitud := fn_config_entero('LONGITUD_NUMERO_FOLIO', 3);
    v_maximo   := fn_config_entero('MAXIMO_TURNOS_DIARIOS', 999);

    -- Mismo contador atomico que `generar_turno()`: un statement, un bloqueo.
    INSERT INTO folios (periodo_operativo_id, tramite_id, ultimo_numero)
    VALUES (v_periodo.id, v_tramite.id, 1)
    ON CONFLICT (periodo_operativo_id, tramite_id)
    DO UPDATE
       SET ultimo_numero  = folios.ultimo_numero + 1,
           actualizado_en = now()
    RETURNING ultimo_numero INTO v_folio;

    IF v_folio > v_maximo THEN
        RAISE EXCEPTION 'Se alcanzo el maximo de turnos diarios (%) para este tramite.',
            v_maximo USING ERRCODE = 'P0001';
    END IF;

    v_codigo := v_tramite.prefijo || '-' || lpad(v_folio::text, v_longitud, '0');
    v_token  := encode(gen_random_bytes(32), 'hex');
    v_expira := calcular_expiracion_token('WAITING');

    INSERT INTO turnos (
        folio, codigo, periodo_operativo_id, tramite_id, modulo_id,
        estado, prioridad, token_publico, token_expira_en,
        tiempo_estimado_mostrado_minutos
    ) VALUES (
        v_folio, v_codigo, v_periodo.id, v_tramite.id, NULL,
        'WAITING', v_original.prioridad, v_token, v_expira,
        v_tramite.tiempo_estimado_minutos
    )
    RETURNING id INTO v_turno_id;

    PERFORM registrar_historial(
        v_turno_id, NULL, 'WAITING', v_operador.id, NULL,
        'Reposicion de ' || v_original.codigo || '.',
        jsonb_build_object('turno_origen', v_original.id,
                           'codigo_origen', v_original.codigo,
                           'motivo_origen', v_original.motivo_salto)
    );

    PERFORM registrar_auditoria(
        v_operador.id, 'REPONER_TURNO', 'turnos', v_turno_id::text, 'EXITO',
        jsonb_build_object('turno_origen', v_original.id,
                           'codigo_origen', v_original.codigo,
                           'codigo_nuevo', v_codigo)
    );

    RETURN jsonb_build_object(
        'ok',                true,
        'turno_id',          v_turno_id,
        'codigo_turno',      v_codigo,
        'folio',             v_folio,
        'token_publico',     v_token,
        'turno_origen',      v_original.id,
        'codigo_origen',     v_original.codigo,
        'clave_tramite',     v_tramite.clave,
        'denominacion_tramite', v_tramite.denominacion,
        'prioridad',         v_original.prioridad,
        'mensaje',           'Reposicion emitida: ' || v_codigo
    );
END;
$$;

COMMENT ON FUNCTION reponer_turno IS
    'P12: el carril de recurso que el mensaje del ciudadano promete. Emite un turno nuevo para un turno omitido o cancelado, enlazado en la auditoria.';

-- ---------------------------------------------------------------------------
-- RPC 03: REPETIR LLAMADA (RF-011)
-- El estado no cambia; solo se incrementa numero_llamadas y se traza.
-- TOMA_TURNO no tenía esta operación.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION repetir_llamada(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    turnos%ROWTYPE;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede repetir llamadas (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.estado <> 'CALLED' THEN
        RAISE EXCEPTION 'Solo se puede repetir la llamada de un turno CALLED (estado actual %).',
            v_turno.estado USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos
       SET numero_llamadas  = numero_llamadas + 1,
           llamado_en       = now(),
           token_expira_en  = calcular_expiracion_token('CALLED')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, 'CALLED', 'CALLED', v_operador, v_turno.modulo_id,
        'Llamada repetida.',
        jsonb_build_object('numero_llamada', v_turno.numero_llamadas + 1)
    );

    PERFORM registrar_auditoria(
        v_operador, 'REPETIR_LLAMADA', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo_turno', v_turno.codigo,
        'numero_llamadas', v_turno.numero_llamadas + 1,
        'llamado_en', now()
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC 04: INICIAR ATENCIÓN  CALLED -> SERVING (RF-014)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION iniciar_atencion_turno(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    turnos%ROWTYPE;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede iniciar atencion (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT fn_transicion_valida(v_turno.estado, 'SERVING') THEN
        RAISE EXCEPTION 'Transicion % -> SERVING no permitida (RN-011).', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos
       SET estado          = 'SERVING',
           inicio_atencion = now(),
           atendido_por    = v_operador,
           token_expira_en = calcular_expiracion_token('SERVING')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, 'CALLED', 'SERVING', v_operador, v_turno.modulo_id,
        'Inicio de atencion del turno.', NULL
    );

    PERFORM registrar_auditoria(
        v_operador, 'INICIAR_ATENCION', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo_turno', v_turno.codigo,
        'estado', 'SERVING',
        'inicio_atencion', now()
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC 05: FINALIZAR TURNO  SERVING -> COMPLETED (RF-015)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finalizar_turno(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    turnos%ROWTYPE;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede finalizar turnos (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT fn_transicion_valida(v_turno.estado, 'COMPLETED') THEN
        RAISE EXCEPTION 'Transicion % -> COMPLETED no permitida (RN-004/RN-011).',
            v_turno.estado USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos
       SET estado          = 'COMPLETED',
           finalizado_en   = now(),
           atendido_por    = COALESCE(v_turno.atendido_por, v_operador),
           token_expira_en = calcular_expiracion_token('COMPLETED')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, 'SERVING', 'COMPLETED', v_operador, v_turno.modulo_id,
        'Atencion finalizada.', NULL
    );

    PERFORM registrar_auditoria(
        v_operador, 'FINALIZAR_TURNO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo_turno', v_turno.codigo,
        'estado', 'COMPLETED',
        'finalizado_en', now()
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC 06: CANCELAR TURNO (RF-016)
-- Exige motivo: lo pide el CHECK chk_turnos_cancelacion de la migración 001.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancelar_turno(
    p_turno_id UUID,
    p_motivo   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    turnos%ROWTYPE;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede cancelar turnos (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    IF p_motivo IS NULL OR length(btrim(p_motivo)) = 0 THEN
        RAISE EXCEPTION 'La cancelacion requiere motivo (RF-016).' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    -- RN-005: un CANCELLED ya no se llama. RN-011: transición válida.
    IF NOT fn_transicion_valida(v_turno.estado, 'CANCELLED') THEN
        RAISE EXCEPTION 'Transicion % -> CANCELLED no permitida (RN-011).', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos
       SET estado            = 'CANCELLED',
           cancelado_en      = now(),
           cancelado_por     = v_operador,
           motivo_cancelacion = btrim(p_motivo),
           token_expira_en   = calcular_expiracion_token('CANCELLED')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, v_turno.estado, 'CANCELLED', v_operador, v_turno.modulo_id,
        btrim(p_motivo), NULL
    );

    PERFORM registrar_auditoria(
        v_operador, 'CANCELAR_TURNO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo, 'motivo', btrim(p_motivo))
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo_turno', v_turno.codigo,
        'estado', 'CANCELLED',
        'motivo', btrim(p_motivo)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC 07: OMITIR TURNO  WAITING/CALLED -> SKIPPED (RF-012)
-- TOMA_TURNO NO tenía este estado: era su carencia más estructural, porque sin
-- SKIPPED no existían ni el timeout automático ni el cierre de jornada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION omitir_turno(
    p_turno_id UUID,
    p_motivo   TEXT,
    p_categoria TEXT DEFAULT 'OMISION_MANUAL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    turnos%ROWTYPE;
    v_anterior enum_estado_turno;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede omitir turnos (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    IF p_motivo IS NULL OR length(btrim(p_motivo)) = 0 THEN
        RAISE EXCEPTION 'La omision requiere motivo (RF-012).' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT fn_transicion_valida(v_turno.estado, 'SKIPPED') THEN
        RAISE EXCEPTION 'Transicion % -> SKIPPED no permitida (RN-006/RN-011).',
            v_turno.estado USING ERRCODE = 'P0001';
    END IF;

    v_anterior := v_turno.estado;

    UPDATE turnos
       SET estado        = 'SKIPPED',
           saltado_en    = now(),
           saltado_por   = v_operador,
           motivo_salto  = btrim(p_motivo) || ' [' || p_categoria || ']',
           token_expira_en = calcular_expiracion_token('SKIPPED')
     WHERE id = v_turno.id;

    PERFORM registrar_historial(
        v_turno.id, v_anterior, 'SKIPPED', v_operador, v_turno.modulo_id,
        btrim(p_motivo),
        jsonb_build_object('categoria', p_categoria)
    );

    PERFORM registrar_auditoria(
        v_operador, 'OMITIR_TURNO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo, 'categoria', p_categoria)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo_turno', v_turno.codigo,
        'estado', 'SKIPPED',
        'motivo', btrim(p_motivo),
        'categoria', p_categoria
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC 08: CONSULTA PÚBLICA POR QR (RF-017, RF-018, RF-019)
--
-- El ciudadano NUNCA hace SELECT sobre `turnos` (Figura 9). Llama a esta
-- función SECURITY DEFINER, que:
--   * valida el token y su vigencia (DRS §9),
--   * devuelve 5 campos públicos: folio, estado, posición, módulo y mensaje,
--   * registra el último acceso (aportado por TOMA_TURNO),
--   * y no expone token, nombres, expedientes ni datos de otros turnos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_turno_publico(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno  turnos%ROWTYPE;
    v_tramite tramites%ROWTYPE;
    v_modulo modulos%ROWTYPE;
    v_pos    INTEGER;
    v_mensaje TEXT;
BEGIN
    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE token_publico = btrim(p_token);
    IF NOT FOUND THEN
        -- RN-010 / criterio de aceptación "token A != turno B".
        RAISE EXCEPTION 'Token invalido o inexistente.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.token_expira_en IS NOT NULL AND v_turno.token_expira_en < now() THEN
        RAISE EXCEPTION 'Token expirado.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;
    SELECT * INTO v_modulo  FROM modulos  WHERE id = v_turno.modulo_id;

    -- Posición por trámite+periodo (RN-014), solo si sigue esperando.
    IF v_turno.estado = 'WAITING' THEN
        SELECT posicion INTO v_pos
        FROM vista_cola_espera
        WHERE turno_id = v_turno.id;
    END IF;

    v_mensaje := CASE v_turno.estado
        WHEN 'WAITING'   THEN 'Su turno esta en espera.'
        WHEN 'CALLED'    THEN '¡Su turno fue llamado! Acudase a ' || COALESCE(v_modulo.codigo, 'su modulo') || '.'
        WHEN 'SERVING'   THEN 'Su turno esta siendo atendido.'
        WHEN 'COMPLETED' THEN 'Su turno fue atendido. Gracias.'
        WHEN 'CANCELLED' THEN 'Su turno fue cancelado.'
        WHEN 'SKIPPED'   THEN 'Su turno no fue atendido. Acuda a ventanilla para reposicion.'
        ELSE 'Consulte en ventanilla.'
    END;

    -- Huella de última consulta ciudadana (aportada por TOMA_TURNO, que la
    -- guardaba en tokens_turno.fecha_ultimo_acceso). Se escribe en la misma
    -- transacción de lectura; por eso la función no es STABLE.
    UPDATE turnos
       SET token_ultimo_acceso = now()
     WHERE id = v_turno.id;

    RETURN jsonb_build_object(
        'ok',              true,
        'codigo_turno', v_turno.codigo,
        'folio',        v_turno.folio,
        'estado',       v_turno.estado,
        'prioridad',    v_turno.prioridad,
        'denominacion_tramite', v_tramite.denominacion,
        'posicion',     COALESCE(v_pos, 0),
        'personas_delante', GREATEST(COALESCE(v_pos, 1) - 1, 0),
        'modulo',       v_modulo.codigo,
        'mensaje',      v_mensaje,
        'creado_en',    v_turno.creado_en,
        'llamado_en',   v_turno.llamado_en,
        'tiempo_estimado_minutos', v_turno.tiempo_estimado_mostrado_minutos,
        'token_expira_en', v_turno.token_expira_en
    );
END;
$$;

COMMENT ON FUNCTION get_turno_publico IS
    'RF-019: unica puerta del ciudadano. Devuelve 5 campos publicos, valida vigencia del token y jamas hace que anon haga SELECT sobre turnos.';

-- ---------------------------------------------------------------------------
-- RPC 09: TIMEOUT AUTOMÁTICO DE CALLED (RF-013, Figura 11)
-- La ejecuta pg_cron, no un navegador. Función idempotente: volver a
-- ejecutarla nunca marca dos veces el mismo turno, gracias a SKIP LOCKED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION timeout_called_turns()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_minutos   INTEGER;
    v_turno     turnos%ROWTYPE;
    v_cancelados INTEGER := 0;
BEGIN
    v_minutos := fn_config_entero('MINUTOS_TIMEOUT_LLAMADA', 5);

    FOR v_turno IN
        SELECT *
          FROM turnos
         WHERE estado = 'CALLED'
           AND llamado_en IS NOT NULL
           AND llamado_en < now() - (v_minutos || ' minutes')::interval
         ORDER BY llamado_en
         FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE turnos
           SET estado          = 'SKIPPED',
               saltado_en      = now(),
               saltado_por     = NULL,
               motivo_salto    = 'TIMEOUT_LLAMADA',
               token_expira_en = calcular_expiracion_token('SKIPPED')
         WHERE id = v_turno.id;

        PERFORM registrar_historial(
            v_turno.id, 'CALLED', 'SKIPPED', NULL, v_turno.modulo_id,
            'No se presento el ciudadano dentro del tiempo de espera.',
            jsonb_build_object('categoria', 'TIMEOUT_LLAMADA', 'timeout_minutos', v_minutos)
        );

        PERFORM registrar_auditoria(
            NULL, 'TIMEOUT_LLAMADA', 'turnos', v_turno.id::text, 'EXITO',
            jsonb_build_object('codigo', v_turno.codigo)
        );

        v_cancelados := v_cancelados + 1;
    END LOOP;

    RETURN v_cancelados;
END;
$$;

COMMENT ON FUNCTION timeout_called_turns IS
    'Figura 11. CALLED -> SKIPPED con motivo TIMEOUT_LLAMADA. Idempotente por FOR UPDATE SKIP LOCKED.';

-- ---------------------------------------------------------------------------
-- RPC 10: ABRIR PERÍODO OPERATIVO (RF-025)
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

    IF NOT fn_es_administrador() THEN
        RAISE EXCEPTION 'Solo administradores abren periodos (RF-025).' USING ERRCODE = '42501';
    END IF;

    -- RF-025: "solo uno activo". Se comprueba antes de tocar nada para poder
    -- distinguir este caso del de una fecha ya usada.
    IF EXISTS (SELECT 1 FROM periodos_operativos WHERE estado = 'ABIERTO') THEN
        RAISE EXCEPTION 'Ya existe un periodo operativo abierto (RF-025).'
            USING ERRCODE = 'P0001';
    END IF;

    -- RG-002: una sola jornada por fecha (UNIQUE sobre `clave`).
    -- Si esa fecha ya se usó y quedó CERRADA, se reabre la misma fila en vez
    -- de intentar insertar otra: el índice UNIQUE(clave) lo impediría.
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
-- RPC 11: CERRAR PERÍODO OPERATIVO (RF-025, Figura 12)
-- WAITING -> SKIPPED y CALLED -> SKIPPED con motivo CIERRE_JORNADA.
-- SERVING no se cierra en silencio: exige finalización o contingencia.
-- TOMA_TURNO no tenía esta operación en absoluto.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cerrar_periodo_operativo(p_periodo_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_periodo  periodos_operativos%ROWTYPE;
    v_cerrados INTEGER := 0;
    v_encurso   INTEGER := 0;
    t           turnos%ROWTYPE;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_es_administrador() THEN
        RAISE EXCEPTION 'Solo administradores cierran periodos (RF-025).' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_periodo
      FROM periodos_operativos
     WHERE id = p_periodo_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El periodo no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF v_periodo.estado <> 'ABIERTO' THEN
        RAISE EXCEPTION 'El periodo ya esta cerrado.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COUNT(*) INTO v_encurso
      FROM turnos
     WHERE periodo_operativo_id = v_periodo.id
       AND estado = 'SERVING';

    IF v_encurso > 0 THEN
        -- Figura 12: "SERVING: no se cierra silenciosamente".
        RAISE EXCEPTION 'Hay % turno(s) en atencion; finalicelos o aplique el procedimiento de contingencia.', v_encurso
            USING ERRCODE = 'P0001';
    END IF;

    FOR t IN
        SELECT * FROM turnos
         WHERE periodo_operativo_id = v_periodo.id
           AND estado IN ('WAITING', 'CALLED')
         ORDER BY creado_en
         FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE turnos
           SET estado          = 'SKIPPED',
               saltado_en      = now(),
               saltado_por     = v_operador,
               motivo_salto    = 'CIERRE_JORNADA',
               token_expira_en = calcular_expiracion_token('SKIPPED')
         WHERE id = t.id;

        PERFORM registrar_historial(
            t.id, t.estado, 'SKIPPED', v_operador, t.modulo_id,
            'Jornada cerrada antes de que el turno fuera atendido.',
            jsonb_build_object('categoria', 'CIERRE_JORNADA', 'periodo', v_periodo.clave)
        );

        v_cerrados := v_cerrados + 1;
    END LOOP;

    UPDATE periodos_operativos
       SET estado = 'CERRADO',
           hora_fin = now(),
           cerrado_en = now()
     WHERE id = v_periodo.id;

    PERFORM registrar_auditoria(
        v_operador, 'CERRAR_PERIODO', 'periodos_operativos', v_periodo.id::text, 'EXITO',
        jsonb_build_object('clave', v_periodo.clave, 'turnos_omitidos', v_cerrados)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'periodo_id', v_periodo.id,
        'clave', v_periodo.clave,
        'estado', 'CERRADO',
        'hora_fin', now(),
        'turnos_omitidos_por_cierre', v_cerrados
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC 12: ASIGNAR MÓDULO A UN USUARIO
-- Equivalente a `asignar_trabajador_ventanilla` de TOMA_TURNO, corregido:
-- allí el UPDATE ocurría sin dejar rastro alguno de quién lo ordenó ni de
-- cuándo (RN-016). Aquí exige administrador y escribe en `auditoria`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION asignar_modulo_usuario(
    p_usuario_id UUID,
    p_modulo_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_admin    UUID;
    v_objetivo usuarios%ROWTYPE;
    v_modulo   modulos%ROWTYPE;
BEGIN
    v_admin := fn_usuario_actual();
    IF v_admin IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_es_administrador() THEN
        RETURN fn_denegar('ASIGNAR_MODULO', 'usuarios', p_usuario_id::text, v_admin.id,
                          'Solo administradores asignan modulos (RN-007).');
    END IF;

    SELECT * INTO v_objetivo FROM usuarios WHERE id = p_usuario_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El usuario no existe.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_objetivo.activo THEN
        RETURN fn_denegar('ASIGNAR_MODULO', 'usuarios', p_usuario_id::text, v_admin.id,
                          'El usuario esta inactivo; no puede recibir un modulo.',
                          jsonb_build_object('operador', v_objetivo.numero_empleado));
    END IF;

    -- p_modulo_id NULL = liberar al operador.
    IF p_modulo_id IS NOT NULL THEN
        SELECT * INTO v_modulo FROM modulos WHERE id = p_modulo_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'El modulo no existe.' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    UPDATE usuarios
       SET modulo_id = p_modulo_id,
           actualizado_en = now()
     WHERE id = p_usuario_id;

    PERFORM registrar_auditoria(
        v_admin, 'ASIGNAR_MODULO', 'usuarios', p_usuario_id::text, 'EXITO',
        jsonb_build_object(
            'operador', v_objetivo.numero_empleado,
            'modulo', CASE WHEN p_modulo_id IS NULL THEN NULL ELSE v_modulo.codigo END
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'usuario_id', p_usuario_id,
        'numero_empleado', v_objetivo.numero_empleado,
        'modulo_id', p_modulo_id,
        'modulo', CASE WHEN p_modulo_id IS NULL THEN NULL ELSE v_modulo.codigo END
    );
END;
$$;

COMMENT ON FUNCTION asignar_modulo_usuario IS
    'Version corregida de asignar_trabajador_ventanilla de TOMA_TURNO: exige administrador y deja registro en auditoria (RN-016).';

-- ===========================================================================
-- RF-028 — NOTIFICACIONES PUSH (DRS v1.5, §5.2, Figuras 1/2/4/9)
--
-- El flujo, ya definido y no en discusión:
--   QR -> /turno/{token} -> get_turno_publico(token) -> ve su turno
--      -> recien entonces le preguntamos si quiere el aviso
--      -> si acepta, el Service Worker genera la suscripcion Web Push
--      -> aqui se guarda, ligada a su token
--      -> cuando el turno se acerca, /api/push entrega el aviso
--         AUNQUE LA PESTANA ESTE CERRADA
--      -> al finalizar/cancelar/expirar, se retira sola.
--
-- Cuatro objetos:
--   registrar_suscripcion_push()   alta   (ciudadano, via anon)
--   eliminar_suscripcion_push()    baja   (ciudadano, via anon)
--   suscripciones_por_notificar()  cola   (solo service_role; lee endpoints
--                                          de TODOS, por eso va revocada)
--   marcar_aviso_push_enviado()    cierre de la entrega
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- RPC 12: ALTA DE SUSCRIPCION (RF-028)
--
-- El parametro es el TOKEN, no un id: conocer el token es lo que autoriza.
-- Encaja con RF-019 — el ciudadano sigue sin hacer SELECT sobre `turnos`;
-- aqui lo que hace es ESCRIBIR en su propia fila de `suscripciones_push`.
--
-- endpoint NO es UNIQUE: el navegador devuelve el mismo endpoint para
-- cualquier suscripcion de este origen, y una persona puede tener dos turnos
-- abiertos en la misma ventanilla. Quien tiene que ser unico es el TURNO
-- (UNIQUE token_publico), y por eso se usa ON CONFLICT sobre esa columna.
-- Los navegadores rotan endpoints con el tiempo, asi que la sustitucion
-- legitimamente se permite. El abuso (apuntar el endpoint de un tercero) lo
-- cubre el limite de tasa del DRS §10, igual que cualquier otra RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION registrar_suscripcion_push(
    p_token        TEXT,
    p_endpoint     TEXT,
    p_clave_p256dh TEXT,
    p_clave_auth   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno    turnos%ROWTYPE;
    v_endpoint TEXT := btrim(COALESCE(p_endpoint, ''));
BEGIN
    IF v_endpoint = '' OR v_endpoint NOT LIKE 'https://%' THEN
        RAISE EXCEPTION 'Endpoint de notificacion invalido.' USING ERRCODE = '22023';
    END IF;

    IF btrim(COALESCE(p_clave_p256dh, '')) = '' OR btrim(COALESCE(p_clave_auth, '')) = '' THEN
        RAISE EXCEPTION 'Claves de suscripcion incompletas.' USING ERRCODE = '22023';
    END IF;

    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    -- Mismo criterio que get_turno_publico: existe y sigue vigente.
    SELECT * INTO v_turno FROM turnos WHERE token_publico = btrim(p_token);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Token invalido o inexistente.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.token_expira_en IS NOT NULL AND v_turno.token_expira_en < now() THEN
        RAISE EXCEPTION 'Token expirado.' USING ERRCODE = 'P0001';
    END IF;

    -- Un turno terminado ya no recibe avisos; nada que suscribir.
    IF v_turno.estado IN ('COMPLETED', 'CANCELLED', 'SKIPPED') THEN
        RAISE EXCEPTION 'El turno ya no recibe notificaciones.' USING ERRCODE = '55006';
    END IF;

    INSERT INTO suscripciones_push (token_publico, endpoint, clave_p256dh, clave_auth, ultima_activacion)
    VALUES (btrim(p_token), v_endpoint, btrim(p_clave_p256dh), btrim(p_clave_auth), NULL)
    ON CONFLICT (token_publico) DO UPDATE
        SET endpoint          = EXCLUDED.endpoint,
            clave_p256dh      = EXCLUDED.clave_p256dh,
            clave_auth        = EXCLUDED.clave_auth,
            activa            = TRUE,
            -- no se reinicia: re-suscribirse no vuelve a disparar el aviso
            -- que ya se entrego en su dia.
            ultima_activacion = suscripciones_push.ultima_activacion;

    RETURN jsonb_build_object(
        'ok',            true,
        'codigo_turno',  v_turno.codigo,
        'estado',        v_turno.estado,
        'mensaje',      'Suscripcion registrada. Recibira un aviso cuando su turno se acerque.'
    );
END;
$$;

COMMENT ON FUNCTION registrar_suscripcion_push(TEXT, TEXT, TEXT, TEXT) IS
    'RF-028: da de alta la suscripcion push del navegador contra su turno. Exige token vigente; una sola suscripcion por turno (ON CONFLICT sobre token_publico).';

-- ---------------------------------------------------------------------------
-- RPC 13: BAJA DE SUSCRIPCION (RF-028)
-- Idempotente a proposit: si el ciudadano pulsa "no quiero avisos" dos veces,
-- o la suscripcion ya se fue al cerrarse el turno, no hay error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eliminar_suscripcion_push(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_borradas INTEGER;
BEGIN
    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    DELETE FROM suscripciones_push WHERE token_publico = btrim(p_token);
    GET DIAGNOSTICS v_borradas = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok',            true,
        'eliminadas',    v_borradas,
        'mensaje',      'Suscripcion retirada.'
    );
END;
$$;

COMMENT ON FUNCTION eliminar_suscripcion_push(TEXT) IS
    'RF-028: da de baja la suscripcion push de un turno. Idempotente: no falla si no existia.';

-- ---------------------------------------------------------------------------
-- RPC 14: COLA DE AVISOS (RF-028)
--
-- Devuelve quien debe recibir un aviso AHORA, con la carga minima que luego
-- sale por Web Push: nunca el token, nunca nombres, ni historial.
--
-- Politica de dos avisos por turno, sin configuracion de intervalos:
--   * CERCANO  (WAITING)  -> solo si todavia no se ha mandado NINGUNO
--                            (`ultima_activacion IS NULL`). Uno, bien puesto.
--   * LLAMADO  (CALLED)   -> si `ultima_activacion` es anterior a `llamado_en`.
--                            Cubre tanto la primera llamada como un repetir
--                            (cada `llamado_en` es nuevo, asi que se avisa
--                            de nuevo) y no duplica si ya se habia mandado.
-- Que el turno pase de "cercano" a "llamado" es exactamente el caso que no
-- puede perderse: el ciudadano puede estar sin la pestana abierta.
--
-- Tampoco sale el token: quien entrega el aviso identifica la fila por
-- `turno_id` y usa `marcar_aviso_push_enviado(turno_id)`. Así ni el servicio
-- de push ni el registro de envío tocan la llave de acceso del ciudadano.
--
-- Esta funcion es la unica que puede leer endpoints AJENOS, por eso se le
-- revoca EXECUTE a `anon` y `authenticated` nada mas crearla: `authenticated`
-- sin rol administrativo no tiene que ver quien recibe avisos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION suscripciones_por_notificar()
RETURNS TABLE (
    turno_id       UUID,
    endpoint       TEXT,
    clave_p256dh   TEXT,
    clave_auth     TEXT,
    codigo_turno   TEXT,
    folio          INTEGER,
    modulo_codigo  TEXT,
    tipo_aviso     TEXT,
    mensaje        TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- Todos los umbrales viven en `configuracion` (RF-023): Catastro puede
    -- moverlos sin tocar el codigo de una funcion.
    v_posicion_max INTEGER := fn_config_entero('POSICION_AVISO_PUSH', 3);
    v_minutos_max  INTEGER := fn_config_entero('MINUTOS_AVISO_PUSH', 10);
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        s.endpoint,
        s.clave_p256dh,
        s.clave_auth,
        t.codigo,
        t.folio,
        m.codigo,
        CASE WHEN t.estado = 'CALLED' THEN 'LLAMADO' ELSE 'CERCANO' END::TEXT,
        CASE WHEN t.estado = 'CALLED'
             THEN 'Su turno fue llamado. Acudase a ' || COALESCE(m.codigo, 'su modulo') || '.'
             ELSE 'Su turno ' || t.codigo || ' esta por llegar. Consulte su posicion en el portal.'
        END::TEXT
    FROM suscripciones_push s
    INNER JOIN turnos t ON t.token_publico = s.token_publico
    LEFT JOIN modulos m ON m.id = t.modulo_id
    LEFT JOIN vista_cola_espera v ON v.turno_id = t.id
    WHERE s.activa
      AND t.token_expira_en IS NOT NULL
      AND t.token_expira_en > now()
      AND (
            -- CERCANO: turno en espera, cerca por posicion o por tiempo,
            -- y todavia no se le habia mandado nada.
            (
                t.estado = 'WAITING'
                AND s.ultima_activacion IS NULL
                AND (
                    COALESCE(v.posicion, 999999) <= v_posicion_max
                    OR COALESCE(t.tiempo_estimado_mostrado_minutos, 999999) <= v_minutos_max
                )
            )
            -- LLAMADO: una vez por cada llamada.
         OR (
                t.estado = 'CALLED'
                AND t.llamado_en IS NOT NULL
                AND (s.ultima_activacion IS NULL OR s.ultima_activacion < t.llamado_en)
            )
          )
    ORDER BY t.codigo, t.folio;
END;
$$;

COMMENT ON FUNCTION suscripciones_por_notificar() IS
    'RF-028: cola de avisos. Devuelve la carga minima (turno_id, endpoint, claves, codigo, folio, modulo, mensaje); jamas el token ni PII. Executable solo por service_role.';

REVOKE EXECUTE ON FUNCTION suscripciones_por_notificar() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC 15: MARCA DE ENTREGA (RF-028)
-- La llama /api/push despues de que el servicio push acepto el mensaje.
-- Sin esto, la cola volveria a ofrecer la misma fila en cada vuelta.
-- Recibe turno_id, no token: el token no hace falta para nada fuera de la
-- validacion ciudadana.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marcar_aviso_push_enviado(p_turno_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_turno_id IS NULL THEN
        RETURN FALSE;
    END IF;

    UPDATE suscripciones_push s
       SET ultima_activacion = clock_timestamp()
      FROM turnos t
     WHERE t.id = p_turno_id
       AND s.token_publico = t.token_publico
       AND s.activa;

    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION marcar_aviso_push_enviado(UUID) IS
    'RF-028: registra el momento en que se entrego un aviso de un turno, para que la cola no lo ofrezca otra vez.';

-- Libreta de mantenimiento interna: marcar una entrega no es algo que el
-- ciudadano deba poder hacer desde el navegador.
REVOKE EXECUTE ON FUNCTION marcar_aviso_push_enviado(UUID) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC 17: RETIRAR LA SUSCRIPCIÓN DE UN TURNO (RF-028)
--
-- La usa `/api/push` cuando el servicio de push responde 404/410 Gone: el
-- navegador eliminó esa suscripción y volver a intentarlo no tiene sentido.
--
-- Recibe el `turno_id` y no el token, por la misma razón que
-- `marcar_aviso_push_enviado`: el token es la credencial del ciudadano y no
-- tiene por qué viajar en esta ruta. La resolución turno → token ocurre
-- dentro de la función, en la base, que es la única que puede verla.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eliminar_suscripcion_por_turno(p_turno_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_borradas INTEGER := 0;
BEGIN
    IF p_turno_id IS NULL THEN
        RETURN 0;
    END IF;

    DELETE FROM suscripciones_push s
     USING turnos t
     WHERE t.id = p_turno_id
       AND s.token_publico = t.token_publico;

    GET DIAGNOSTICS v_borradas = ROW_COUNT;
    RETURN v_borradas;
END;
$$;

COMMENT ON FUNCTION eliminar_suscripcion_por_turno(UUID) IS
    'RF-028: retira la suscripcion de un turno cuando el servicio de push la da por muerta (404/410). Solo service_role.';


-- ---------------------------------------------------------------------------
-- RPC 20: ULTIMAS LLAMADAS (RF-020, pantalla pública)
--
-- La pantalla pública de la sala de espera necesita saber a quién se está
-- llamando. Antes de esta función, esa pantalla pedía la vista
-- `vista_turnos_actuales` directamente desde el navegador, y eso estaba mal
-- por partida doble:
--
--   1. NO FUNCIONABA. La RLS no da acceso a `anon` a esa vista: la
--      pantalla se quedaba SIEMPRE en "Espere a que se llamen los turnos",
--      sin importar cuántas llamadas hubiera. Parecía que no había turno y
--      en realidad era un permiso denegado.
--   2. INCLINABA EL RF-020, que exige "canal/RPC pública controlada, nunca
--      anon key directo a `turnos`".
--
-- Así que aquí hay una RPC pública controlada. Es `SECURITY DEFINER` porque
-- lo que autoriza es «enseñar el último llamado», no «leer la tabla de
-- turnos»: la RLS no se relaja en ningún sitio.
--
-- Lo que devuelve son CUATRO campos y ninguno más:
--   codigo_turno, codigo_modulo, denominacion_tramite, llamado_en.
-- No hay token, no hay folio, no hay motivo, no hay nombre, no hay correo.
-- Un turno anónimo se puede mostrar en un cartel sin revelarle nada a nadie.
--
-- Solo turnos en estado CALLED (llamado y todavía no atendido) y solo del
-- periodo en curso: si no hay periodo abierto, el último periodo cerrado.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ultimas_llamadas(p_limite INTEGER DEFAULT 8)
RETURNS TABLE (
    codigo_turno      TEXT,
    codigo_modulo     TEXT,
    denominacion_tramite TEXT,
    llamado_en        TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limite  INTEGER := LEAST(GREATEST(COALESCE(p_limite, 8), 1), 20);
    v_periodo UUID;
BEGIN
    -- El periodo en curso; si ya se cerro, el ultimo que se abrio.
    SELECT id INTO v_periodo
    FROM periodos_operativos
    WHERE estado = 'ABIERTO'
    ORDER BY clave DESC
    LIMIT 1;

    IF v_periodo IS NULL THEN
        SELECT id INTO v_periodo
        FROM periodos_operativos
        ORDER BY clave DESC
        LIMIT 1;
    END IF;

    IF v_periodo IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT t.codigo,
           m.codigo,
           tr.denominacion,
           t.llamado_en
    FROM turnos t
    INNER JOIN tramites tr ON tr.id = t.tramite_id
    LEFT  JOIN modulos  m  ON m.id  = t.modulo_id
    WHERE t.periodo_operativo_id = v_periodo
      AND t.estado = 'CALLED'
      AND t.llamado_en IS NOT NULL
    ORDER BY t.llamado_en DESC
    LIMIT v_limite;
END;
$$;

COMMENT ON FUNCTION ultimas_llamadas(INTEGER) IS
    'RF-020: las ultimas llamadas para la pantalla publica. RPC publica controlada: devuelve solo codigo, modulo, tramite y hora. Sin token, sin folio, sin datos personales.';



-- ---------------------------------------------------------------------------
-- RPC 19: MANIFESTAR CONSIDERACIONES (RF-033)
--
-- La LFPDPPP da a toda persona titular el derecho a oponerse al
-- tratamiento de sus datos por causa legitima (art. 21). En SITUR el titular
-- no deja datos de identidad: su unica credencial es el token. Por eso el
-- derecho se hace valer por ahi: el ciudadano escribe su consideracion en
-- el portal, con su token, y el turno queda cancelado con constancia de que
-- fue el titular y no el operador.
--
-- Es `SECURITY DEFINER` y ejecutable por `anon`, igual que
-- `get_turno_publico`: lo que autoriza es conocer el token, no haber
-- iniciado sesion. El token es lo que el ciudadano ya lleva en el QR.
--
-- No se guarda ningun dato de identidad: solo el texto que el titular
-- escribe (300 caracteres como maximo) sobre un turno que ya no tiene
-- nombre, correo ni telefono.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION manifestar_consideraciones(
    p_token          TEXT,
    p_consideraciones TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno    turnos%ROWTYPE;
    v_texto    TEXT;
BEGIN
    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE token_publico = btrim(p_token);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Token invalido o inexistente.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.estado IN ('COMPLETED', 'CANCELLED', 'SKIPPED') THEN
        RAISE EXCEPTION 'Este turno ya no esta en espera: no hay nada que oponer.'
            USING ERRCODE = 'P0001';
    END IF;

    v_texto := btrim(COALESCE(p_consideraciones, ''));
    IF length(v_texto) = 0 OR length(v_texto) > 300 THEN
        RAISE EXCEPTION 'La consideracion debe tener entre 1 y 300 caracteres.'
            USING ERRCODE = '22023';
    END IF;

    UPDATE turnos
       SET estado            = 'CANCELLED',
           cancelado_en       = now(),
           cancelado_por      = NULL,
           motivo_cancelacion = v_texto,
           consideraciones    = v_texto
     WHERE id = v_turno.id;

    -- La traza lo distingue de una cancelacion del operador: la accion es
    -- del titular, no de la ventanilla.
    PERFORM registrar_historial(
        v_turno.id, v_turno.estado, 'CANCELLED', NULL, NULL,
        'El titular manifesto una consideracion y se opuso al tratamiento.',
        jsonb_build_object('origen', 'titular', 'longitud', length(v_texto))
    );

    PERFORM registrar_auditoria(
        NULL, 'MANIFESTAR_CONSIDERACIONES', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo, 'origen', 'titular')
    );

    RETURN jsonb_build_object(
        'ok', true,
        'codigo_turno', v_turno.codigo,
        'estado', 'CANCELLED',
        'mensaje', 'Su consideracion quedo registrada y su turno se cancelo. ' ||
                   'Si Cree que hubo un error, acuda a la ventanilla con su codigo.'
    );
END;
$$;

COMMENT ON FUNCTION manifestar_consideraciones(TEXT, TEXT) IS
    'RF-033: el titular manifiesta su consideracion y se opone al tratamiento (LFPDPPP art. 21). Se valida con el token, no con una sesion.';



-- ---------------------------------------------------------------------------
-- RPC 18: PURGAR LOS TOKENS CADUCADOS (RF-027 - proteccion de datos)
--
-- El token publico es la credencial UNICA del ciudadano (RF-017). Cuando
-- caduca ya no sirve para nada, pero se quedaba en la fila para siempre: una
-- credencial muerta guardada indefinidamente en una tabla que ademas es
-- inmutable.
--
-- Se purgan los tokens que llevan mas de un dia vencidos. El dia extra
-- respeta el ciclo de vida del DRS §9 (COMPLETED 24 h, CANCELLED/SKIPPED 1 h)
-- antes de borrar nada.
--
-- La suscripcion push se borra antes: `suscripciones_push.token_publico`
-- referencia a `turnos.token_publico` con ON UPDATE CASCADE, y poner el
-- token a NULL sin borrar antes la suscripcion violaria la clave foranea.
--
-- NO se borra la fila del turno: el historial de la atencion se conserva
-- (RF-021). Lo que se retira es la credencial.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purgar_tokens_caducados()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_borrados INTEGER := 0;
BEGIN
    -- Primero las suscripciones de esos turnos (la FK lo exige).
    DELETE FROM suscripciones_push s
     USING turnos t
     WHERE t.token_publico = s.token_publico
       AND t.token_expira_en IS NOT NULL
       AND t.token_expira_en < now() - INTERVAL '1 day';

    DELETE FROM turnos t
     WHERE t.token_publico IS NOT NULL
       AND t.token_expira_en IS NOT NULL
       AND t.token_expira_en < now() - INTERVAL '1 day';

    GET DIAGNOSTICS v_borrados = ROW_COUNT;
    RETURN v_borrados;
END;
$$;

COMMENT ON FUNCTION purgar_tokens_caducados() IS
    'RF-027: retira el token publico de los turnos caducados hace mas de un dia. El token es la credencial unica del ciudadano (RF-017).';

-- Ni el ciudadano ni el operador pueden invocar esto: es mantenimiento del
-- emisor de push.
REVOKE EXECUTE ON FUNCTION eliminar_suscripcion_por_turno(UUID) FROM PUBLIC, anon, authenticated;
