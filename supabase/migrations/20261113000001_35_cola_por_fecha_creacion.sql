-- ============================================================================
-- SITUR — MIGRACIÓN 035: LA COLA SE ORDENA POR FECHA DE CREACIÓN
-- ============================================================================
--
-- PROBLEMA
--
-- La cola se leía de `vista_cola_espera`, que NO tenía `ORDER BY`. Sin él,
-- el orden de las filas lo decidía el planificador: el índice `idx_turnos_cola`
-- es `(periodo_operativo_id, tramite_id, estado, prioridad, creado_en)`, así
-- que las filas salían AGRUPADAS POR TRÁMITE y no por llegada. Un turno de
-- gravámenes (G-0001) aparecía antes que uno de predial (A-002) aunque el
-- segundo fuera más antiguo, y el número que se veía al lado no correspondía
-- con el orden real de llamada.
--
-- Y el folio no sirve para ordenar: es un contador POR TRÁMITE
-- (`folios` es UNIQUE(periodo_operativo_id, tramite_id) y el código es
-- prefijo + folio), así que «G-0001» y «A-002» no son comparables. El único
-- dato que dice quién llegó antes es `creado_en`.
--
-- SOLUCIÓN
--
-- 1. La vista fija su orden (el real de llamada, RN-017) y expone además
--    `posicion_llegada`: la posición global por fecha de creación. Ese es el
--    número que la pantalla en vivo muestra al ciudadano, porque es el que
--    responde a «¿cuántas personas hay delante de mí?».
--
-- 2. `cola_en_vivo()`: la cola de la pantalla en vivo, del periodo abierto,
--    ordenada por llegada. Es la única fuente de la pantalla (RF-017: el
--    ciudadano nunca lee `turnos` directo).
--
-- 3. `ultimo_turno_emitido()`: el último turno emitido con su token, que es
--    el que la pantalla en vivo ofrece para escanear. Antes el QR pointed a
--    `/turno/R-006` —un CÓDIGO, no un token— y el portal del ciudadano
--    respondía «Token invalido».
--
-- 4. La prioridad ya no se hereda del catálogo. `generar_turno` usaba
--    `COALESCE(p_prioridad, v_tramite.prioridad)`, y como «Registro catastral»
--    está PREFERENTE en el catálogo, TODO turno de ese trámite salía
--    PREFERENTE sin que nadie lo decidiera y se adelantaba a los que habían
--    llegado antes. El DRS (§ ficha de `turnos`) dice que la prioridad de un
--    turno es NORMAL por defecto, y la consola la ofrece como NORMAL: la
--    base contradecía a las dos. Ahora la decide el operador.
--
-- Lo que NO cambia: RN-017 (prioridad → fecha de creación → id) sigue siendo
-- el orden real de llamada, y un turno marcado URGENTE o PREFERENTE a mano
-- sigue adelantando a los demás.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. LA VISTA: orden fijo y posición por llegada
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE VIEW exige que las columnas existentes se mantengan en el
-- mismo orden y con el mismo tipo; las nuevas solo pueden añadirse al final.
-- Por eso `posicion_llegada` va al final de la lista.
CREATE OR REPLACE VIEW vista_cola_espera AS
WITH orden AS (
    SELECT
        t.id,
        t.folio,
        t.codigo,
        t.periodo_operativo_id,
        t.tramite_id,
        t.prioridad,
        t.creado_en,
        t.tiempo_estimado_mostrado_minutos,
        t.reclamado_en,
        t.aviso_programado_en,
        -- RN-014: posición dentro del trámite (la que ve el ciudadano).
        ROW_NUMBER() OVER (
            PARTITION BY t.periodo_operativo_id, t.tramite_id
            ORDER BY
                CASE t.prioridad
                    WHEN 'URGENTE'    THEN 1
                    WHEN 'PREFERENTE' THEN 2
                    ELSE 3
                END,
                t.creado_en,
                t.id
        ) AS posicion,
        -- RN-017: orden real de llamada entre todos los trámites.
        ROW_NUMBER() OVER (
            PARTITION BY t.periodo_operativo_id
            ORDER BY
                CASE t.prioridad
                    WHEN 'URGENTE'    THEN 1
                    WHEN 'PREFERENTE' THEN 2
                    ELSE 3
                END,
                t.creado_en,
                t.id
        ) AS posicion_global,
        -- ORDEN POR LLEGADA: solo `creado_en` (y `id` de desempate).
        -- Es el orden que la pantalla en vivo muestra, porque el folio no es
        -- comparable entre trámites y la prioridad la decide el operador.
        ROW_NUMBER() OVER (
            PARTITION BY t.periodo_operativo_id
            ORDER BY t.creado_en, t.id
        ) AS posicion_llegada
    FROM turnos t
    WHERE t.estado = 'WAITING'
)
SELECT
    o.id                                 AS turno_id,
    o.codigo                             AS codigo_turno,
    o.folio,
    o.periodo_operativo_id,
    o.tramite_id,
    tr.clave                             AS clave_tramite,
    tr.denominacion                      AS denominacion_tramite,
    o.prioridad,
    o.posicion,
    o.posicion - 1                       AS personas_delante,
    o.posicion_global,
    o.creado_en,
    o.tiempo_estimado_mostrado_minutos,
    tr.tiempo_estimado_minutos,
    o.reclamado_en,
    o.aviso_programado_en,
    (o.aviso_programado_en IS NOT NULL) AS tiene_aviso_programado,
    o.posicion_llegada
FROM orden o
INNER JOIN tramites tr ON tr.id = o.tramite_id
ORDER BY o.posicion_global;

COMMENT ON VIEW vista_cola_espera IS
    'Cola de espera por periodo, con la posicion por tramite (RN-014), el orden real de llamada (RN-017) y la posicion por llegada (posicion_llegada, por fecha de creacion).';

-- ---------------------------------------------------------------------------
-- 2. COLA EN VIVO: la cola de la pantalla, por fecha de creación
-- ---------------------------------------------------------------------------
-- Se lee de la vista (que ya viene ordenada) y se limita al periodo ABIERTO.
-- `SECURITY DEFINER` porque `turnos` solo es legible por ADMINISTRADOR y
-- RECEPCIÓN (RLS), y esta pantalla la abre cualquier operador.
CREATE OR REPLACE FUNCTION public.cola_en_vivo(p_limite integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo UUID;
    v_total   INTEGER;
    v_filas   JSONB;
BEGIN
    IF NOT (public.fn_puede_operar_turnos() OR public.fn_es_recepcion()) THEN
        RAISE EXCEPTION 'No tiene permiso para ver la cola en vivo.'
            USING ERRCODE = '42501';
    END IF;

    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object(
            'ok',        true,
            'periodo',   NULL,
            'total',     0,
            'filas',     '[]'::jsonb
        );
    END IF;

    SELECT count(*) INTO v_total
      FROM turnos
     WHERE estado = 'WAITING'
       AND periodo_operativo_id = v_periodo;

    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_filas
      FROM (
        SELECT
            jsonb_build_object(
                'turno_id',            v.turno_id,
                'codigo_turno',        v.codigo_turno,
                'folio',               v.folio,
                'clave_tramite',       v.clave_tramite,
                'denominacion_tramite', v.denominacion_tramite,
                'prioridad',           v.prioridad,
                'posicion_llegada',    v.posicion_llegada,
                'posicion_global',     v.posicion_global,
                'creado_en',           v.creado_en
            ) AS fila
        FROM vista_cola_espera v
        WHERE v.periodo_operativo_id = v_periodo
        ORDER BY v.posicion_llegada
        LIMIT greatest(coalesce(p_limite, 10), 0)
      ) s;

    RETURN jsonb_build_object(
        'ok',      true,
        'periodo', v_periodo,
        'total',   v_total,
        'filas',   v_filas
    );
END;
$$;

COMMENT ON FUNCTION public.cola_en_vivo(integer) IS
    'Cola del periodo abierto ordenada por fecha de creacion (posicion_llegada), con el total de turnos en espera. Para la pantalla de turnos en vivo.';

-- ---------------------------------------------------------------------------
-- 3. ÚLTIMO TURNO EMITIDO (para escanear)
-- ---------------------------------------------------------------------------
-- Devuelve el token del último turno emitido del periodo abierto: es el papel
-- que la persona acaba de recibir en la ventanilla y el primero que escanea.
CREATE OR REPLACE FUNCTION public.ultimo_turno_emitido()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_periodo UUID;
    v_turno   turnos%ROWTYPE;
    v_tramite tramites%ROWTYPE;
BEGIN
    IF NOT (public.fn_puede_operar_turnos() OR public.fn_es_recepcion()) THEN
        RAISE EXCEPTION 'No tiene permiso para ver el último turno emitido.'
            USING ERRCODE = '42501';
    END IF;

    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'hay_turno', false);
    END IF;

    SELECT * INTO v_turno
      FROM turnos
     WHERE periodo_operativo_id = v_periodo
     ORDER BY creado_en DESC, id DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', true, 'hay_turno', false);
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    RETURN jsonb_build_object(
        'ok',                 true,
        'hay_turno',          true,
        'turno_id',           v_turno.id,
        'codigo_turno',       v_turno.codigo,
        'folio',              v_turno.folio,
        'estado',             v_turno.estado,
        'prioridad',          v_turno.prioridad,
        'token_publico',      v_turno.token_publico,
        'clave_tramite',      v_tramite.clave,
        'denominacion_tramite', v_tramite.denominacion,
        'creado_en',          v_turno.creado_en
    );
END;
$$;

COMMENT ON FUNCTION public.ultimo_turno_emitido() IS
    'Ultimo turno emitido del periodo abierto, con su token publico, para el QR de la pantalla de turnos en vivo.';

-- ---------------------------------------------------------------------------
-- 4. LA PRIORIDAD LA DECIDE EL OPERADOR
-- ---------------------------------------------------------------------------
-- El catálogo dice qué tramites son «preferentes», pero eso es una
-- SUGERENCIA del catalogo, no la decision de llamar antes a una persona
-- concreta. Antes, `COALESCE(p_prioridad, v_tramite.prioridad)` convertia
-- esa sugerencia en una orden: todo turno de «Registro catastral» salia
-- PREFERENTE y se adelantaba a quien habia llegado antes.
CREATE OR REPLACE FUNCTION public.generar_turno(
    p_tramite_id uuid,
    p_prioridad enum_prioridad_turno DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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

    -- La prioridad la decide quien opera. Antes tomaba la del tramite
    -- (que es una sugerencia del catalogo) y por eso todo turno de un
    -- tramite PREFERENTE se adelantaba a los demas.
    v_prioridad := COALESCE(p_prioridad, 'NORMAL'::enum_prioridad_turno);
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
      JOIN tramites tr ON tr.id = t.tramite_id
      JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
     WHERE t.id = v_turno_id;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.generar_turno(uuid, enum_prioridad_turno) IS
    'Emite un turno. La prioridad la decide el operador (NORMAL por defecto); el catalogo del tramite ya no la impone (mig 35).';

-- `generar_turnos_masivos(p_lotes jsonb)` llama a `generar_turno(tramite, NULL)`
-- por cada turno, así que hereda la misma regla sin tocar su codigo.

-- ---------------------------------------------------------------------------
-- 5. LOS TURNOS EN ESPERA DE HOY, A PRIORIDAD NORMAL
-- ---------------------------------------------------------------------------
-- Los que quedaron PREFERENTE en el periodo abierto lo quedaron por la
-- herencia del catálogo, no porque alguien lo decidiera. Se normalizan para
-- que la cola que se ve hoy sea la que la base va a producir mañana.
DO $$
DECLARE
    v_periodo UUID;
BEGIN
    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN;
    END IF;

    UPDATE turnos
       SET prioridad = 'NORMAL'
     WHERE periodo_operativo_id = v_periodo
       AND estado = 'WAITING'
       AND prioridad = 'PREFERENTE';
END;
$$;

COMMENT ON COLUMN turnos.prioridad IS
    'Prioridad del turno (NORMAL|PREFERENTE|URGENTE). La decide el operador: es NORMAL por defecto y el catalogo del tramite ya no la impone (mig 35). Solo un URGENTE o PREFERENTE marcado a mano se adelanta al resto (RN-017).';

NOTIFY pgrst, 'reload schema';

COMMIT;
