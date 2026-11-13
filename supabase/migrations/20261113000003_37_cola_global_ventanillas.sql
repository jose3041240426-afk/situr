-- ============================================================================
-- SITUR — MIGRACIÓN 037: COLA GLOBAL FIFO Y ASIGNACIÓN A VENTANILLA
-- ============================================================================
--
-- PROBLEMA
--
-- El operador trabajaba en una consola con UNA cola global y un botón «Llamar».
-- El botón llamaba al siguiente turno de toda la cola (RN-017) y lo asignaba
-- al módulo del operador. Con varias ventanillas operando a la vez:
--
--   · No había forma de saber qué ventanilla tenía qué turno: el turno
--     llevaba `modulo_id`, pero la pantalla no lo mostraba.
--   · No se podía pedir «el siguiente para MI ventanilla»: la llamada se
--     asignaba al módulo del operador, que puede no ser el que lo pidió.
--   · «Llamar» era una acción reflexiva: el operador no veía a quién se le
--     iba a llamar hasta después de pulsarlo.
--
-- SOLUCIÓN
--
-- 1. `solicitudes_ventanilla`: las peticiones de turno que están esperando.
--    Es lo que permite el reparto equitativo (ver punto 4).
--
-- 2. `solicitar_turno_ventanilla(p_modulo_id)`: la asignación atómica.
--
--      · UNA transacción: se elige el turno y se le asigna la ventanilla en
--        el mismo COMMIT. Nunca queda un turno «tomado» sin dueño.
--      · `FOR UPDATE SKIP LOCKED` sobre el primer turno de la cola: si dos
--        operadores piden a la vez, cada uno se lleva un turno DISTINTO, y el
--        que pierde la carrera no se queda esperando: pasa al siguiente.
--      · El turno elegido es SIEMPRE el primero de la cola global (FIFO).
--        No hay forma de saltarse a uno posterior: la función no acepta un
--        identificador de turno, solo la ventanilla que lo pide.
--      · Valida que la ventanilla esté operativa, que el operador tenga
--        derecho sobre ella y que no rebase el tope de turnos abiertos.
--
-- 3. CONCURRENCIA REAL
--
--      La fila se bloquea con `FOR UPDATE`, así que dos transacciones
--      simultáneas sobre el MISMO turno se serializan. Con `SKIP LOCKED` en
--      la cola, dos peticiones simultáneas se reparten turnos distintos en
--      lugar de esperar la una a la otra.
--
--      Además, todo el reparto se hace bajo un `pg_advisory_xact_lock` del
--      periodo: así el «orden de las solicitudes que el sistema establece»
--      (RN-017 y el reparto) es único y no depende del azar de quién llegó
--      antes al bloqueo de una fila.
--
-- 4. REPARTO EQUITATIVO
--
--      «La equidad solamente debe determinar qué ventanilla recibe el
--      siguiente turno, nunca qué turno se entrega.»
--
--      Eso son DOS colas distintas, y la confusión entre ellas es el error
--      que hay que evitar:
--
--        · QUÉ TURNO se entrega: el primero de la cola global, siempre.
--          Es FIFO puro y no se negocia.
--        · A QUIÉN se entrega: si hay peticiones esperando, gana la
--          ventanilla que más tiempo lleva SIN ASIGNACIÓN. A igualdad de
--          tiempo, la petición más antigua.
--
--      El tiempo sin asignación se lleva en `modulos.ultima_asignacion_en`.
--      Sin ese dato la equidad no tendría de dónde sacarse, y el reparto
--      dependería del orden de llegada al bloqueo de una fila, que es
--      justamente lo que la equitatividad viene a sustituir.
--
--      No hay pesos ni predicciones de duración: el único dato es «cuánto
--      tiempo lleva esta ventanilla sin recibir nada», que es un hecho, no
--      una estimación.
--
-- 5. NO SE LIBERA UN TURNO POR DESCONEXIÓN
--
--      Un turno asignado a una ventanilla sigue siendo suyo. La pantalla
--      que se cierra, la pestaña que se recarga o la red que se cae NO
--      devuelven el turno a la cola: para eso están «omitir» y «cancelar»,
--      que son decisiones del operador y quedan auditadas. Perder la
--      conexión no es una decisión.
--
-- 6. ESTADOS
--
--      Se reutiliza la máquina de estados que ya existe (RN-011):
--      WAITING → CALLED → SERVING → COMPLETED, con CANCELLED y SKIPPED.
--      «Turno asignado a una ventanilla» es CALLED con `modulo_id` puesto:
--      es el mismo estado que «llamado», que es exactamente lo que es.
--      No se crean estados nuevos.
--
-- 7. LO QUE VE EL OPERADOR
--
--      `estado_ventanillas()` da en una sola lectura la cola global (en el
--      orden real de llamada) y el estado de cada ventanilla. La cola que
--      se ve es la que se entrega: mismo ORDER BY que `llamar_siguiente_turno`.
--
--      Las vistas NO llevan `security_invoker`, igual que
--      `vista_cola_espera` y `vista_turnos_actuales`: el rol AGENTE no tiene
--      política de SELECT sobre `turnos` y las lee a través de la vista. Por
--      eso estas vistas NO pueden llevar `token_publico`: el token es la
--      credencial del ciudadano y no se expone a los operadores (como se
--      corrigió en `vista_seguimiento_turnos`).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. CONTADOR DE EQUIDAD POR VENTANILLA
-- ---------------------------------------------------------------------------
-- Una columna en `modulos`: cuándo recibió su última asignación. Es lo que
-- permite repartir con equidad cuando varias ventanillas piden a la vez.
ALTER TABLE public.modulos
  ADD COLUMN IF NOT EXISTS ultima_asignacion_en timestamptz;

COMMENT ON COLUMN public.modulos.ultima_asignacion_en IS
  'Ultima vez que esta ventanilla recibio un turno. Sirve para repartir con equidad cuando varias piden a la vez: primero la que mas tiempo lleva sin recibir nada (mig 37).';

-- ---------------------------------------------------------------------------
-- 2. PETICIONES PENDIENTES DE LAS VENTANILLAS
-- ---------------------------------------------------------------------------
-- Una fila por petición de turno de una ventanilla.
--
-- ¿POR QUÉ HACE FALTA UNA TABLA?
--
-- El reparto equitativo necesita saber si hay OTRAS ventanillas esperando
-- ahora mismo. Con dos peticiones simultáneas, la segunda transacción no ve
-- a la primera (todavía no ha confirmado), así que no podría saber que
-- compite con ella. La tabla hace visible la competencia: las dos peticiones
-- quedan registradas y ambas ven a la otra.
--
-- Es también lo que hace que el reparto sea JUSTO y no azaroso: la petición
-- que más tiempo lleva esperando es la que se sirve, y eso se decide leyendo
-- datos, no por el orden en que las peticiones llegaron al bloqueo de la fila.
--
-- La petición se borra en cuanto se sirve: no es un historial (eso está en
-- `historial_turnos` y `auditoria`), es el estado de «quién está esperando».
CREATE TABLE IF NOT EXISTS public.solicitudes_ventanilla (
    id                  bigserial PRIMARY KEY,
    periodo_operativo_id uuid NOT NULL REFERENCES public.periodos_operativos(id) ON DELETE CASCADE,
    modulo_id           uuid NOT NULL REFERENCES public.modulos(id) ON DELETE CASCADE,
    operador_id         uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    creado_en           timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.solicitudes_ventanilla IS
  'Peticiones de turno de las ventanillas. Solo guarda las PENDIENTES (las que compiten por equitatividad); las servidas se borran. El historico esta en historial_turnos y auditoria (mig 37).';

CREATE INDEX IF NOT EXISTS idx_solicitudes_ventanilla_pendientes
    ON public.solicitudes_ventanilla (periodo_operativo_id, id);

-- ---------------------------------------------------------------------------
-- 3. EL REPARTO: QUÉ TURNO SE ENTREGA Y A QUIÉN
-- ---------------------------------------------------------------------------
-- Función INTERNA. Reparte los turnos pendientes entre las ventanillas que
-- los han pedido, aplicando la equitatividad.
--
-- Se deja en una función aparte porque la usan dos caminos: la petición del
-- operador y el reparto automático al emitir un turno nuevo (punto 6).
CREATE OR REPLACE FUNCTION public.fn_repartir_turnos_ventanilla(p_periodo_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tope      INTEGER;
    v_sol       solicitudes_ventanilla%ROWTYPE;
    v_turno     turnos%ROWTYPE;
    v_tramite   tramites%ROWTYPE;
    v_servidas  INTEGER := 0;
BEGIN
    -- Un candado por periodo: serializa el reparto entero, venga de la
    -- petición del operador o del disparador de emisión. Así el «orden de
    -- las solicitudes que el sistema establece» es único y no depende del
    -- azar de quién llegó antes al bloqueo de una fila.
    --
    -- Es reentrante dentro de la misma transacción: `solicitar_turno_ventanilla`
    -- lo toma antes de registrar la petición (para que el dedupe no se cruce
    -- con otra transacción) y aquí lo vuelve a tomar sin esperarse a sí misma.
    PERFORM pg_advisory_xact_lock(4242::int, hashtext(p_periodo_id::text));

    SELECT COALESCE(
        (SELECT NULLIF(btrim(valor), '')::INTEGER
           FROM configuracion
          WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'),
        3
    ) INTO v_tope;

    -- [A] QUÉ TURNO SE ENTREGA ----------------------------------------------
    -- El primero de la cola global, siempre. Este SELECT es el FIFO: la
    -- prioridad va delante por RN-017 y, dentro de cada prioridad, la hora
    -- de creación. El desempate por `id` (UUID) es estable.
    --
    -- `FOR UPDATE SKIP LOCKED` hace dos cosas: serializa contra otra
    -- transacción que esté tomando ESTE turno, y si el turno está bloqueado
    -- pasa al siguiente en vez de esperar. Así dos peticiones simultáneas se
    -- llevan turnos 1 y 2 (consecutivos en la cola global) y ninguna se
    -- salta a un tercero.
    --
    -- La prioridad del TURNO no se negocia: la equidad de abajo decide a QUIÉN
    -- se entrega, nunca CUÁL.
    SELECT * INTO v_turno
      FROM turnos
     WHERE periodo_operativo_id = p_periodo_id
       AND estado = 'WAITING'
     ORDER BY
        CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
        creado_en,
        id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- [B] A QUIÉN SE ENTREGA -----------------------------------------------
    -- Entre las ventanillas que tienen una petición PENDIENTE, gana la que
    -- más tiempo lleva SIN ASIGNACIÓN (`ultima_asignacion_en` más antigua).
    -- La que nunca ha recibido nada es la que más ha esperado.
    --
    -- A igualdad de tiempo sin asignación, la petición más antigua: el
    -- orden en que llegaron.
    --
    -- Solo se consideran ventanillas que pueden recibir: operativas, sin
    -- turno en curso (una ventanilla atiende a una persona) y con el tope
    -- configurado por encima de 0.
    SELECT sv.* INTO v_sol
      FROM solicitudes_ventanilla sv
      JOIN modulos m ON m.id = sv.modulo_id
     WHERE sv.periodo_operativo_id = p_periodo_id
       AND m.activo
       AND m.estado = 'ACTIVO'
       AND v_tope > 0
       AND NOT EXISTS (
              SELECT 1 FROM turnos t
               WHERE t.modulo_id = m.id
                 AND t.estado IN ('CALLED', 'SERVING'))
     ORDER BY COALESCE(m.ultima_asignacion_en, '-infinity'::timestamptz) ASC,
              sv.creado_en ASC,
              sv.id ASC
     LIMIT 1;

    -- Sin peticiones pendientes, el turno se queda esperando: no se inventa
    -- a quién entregarlo. La próxima petición se lo llevará.
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- [C] TRANSICIÓN VÁLIDA (RN-011) ---------------------------------------
    IF NOT fn_transicion_valida(v_turno.estado, 'CALLED') THEN
        RAISE EXCEPTION 'Transicion % -> CALLED no permitida.', v_turno.estado
            USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    -- [D] ASIGNAR -----------------------------------------------------------
    UPDATE turnos
       SET estado          = 'CALLED',
           modulo_id       = v_sol.modulo_id,
           atendido_por    = v_sol.operador_id,
           llamado_en      = now(),
           numero_llamadas = numero_llamadas + 1,
           token_expira_en = calcular_expiracion_token('CALLED')
     WHERE id = v_turno.id;

    -- El contador de equidad: desde ahora, esta ventanilla es la última que
    -- recibió un turno.
    UPDATE modulos
       SET ultima_asignacion_en = now(),
           actualizado_en       = now()
     WHERE id = v_sol.modulo_id;

    PERFORM registrar_historial(
        v_turno.id, 'WAITING', 'CALLED', v_sol.operador_id, v_sol.modulo_id,
        'Turno asignado a la ventanilla.',
        jsonb_build_object('modulo', (SELECT codigo FROM modulos WHERE id = v_sol.modulo_id),
                           'numero_llamada', v_turno.numero_llamadas + 1)
    );

    PERFORM registrar_auditoria(
        v_sol.operador_id, 'SOLICITAR_TURNO_VENTANILLA', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object(
            'modulo', (SELECT codigo FROM modulos WHERE id = v_sol.modulo_id),
            'codigo', v_turno.codigo)
    );

    -- La petición servida desaparece: la tabla guarda solo lo que está
    -- esperando. El historial del turno ya está en `historial_turnos`.
    DELETE FROM solicitudes_ventanilla WHERE id = v_sol.id;

    v_servidas := v_servidas + 1;
    RETURN v_servidas;
END;
$$;

COMMENT ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) IS
  'Reparte el primer turno de la cola global entre las ventanillas que lo han pedido. El TURNO es el primero de la cola (FIFO); la EQUIDAD decide a quien se entrega. Uso interno (mig 37).';

-- ---------------------------------------------------------------------------
-- 4. ASIGNACIÓN ATÓMICA DE UN TURNO A UNA VENTANILLA
-- ---------------------------------------------------------------------------
-- Lo que pulsa el operador. UNA transacción de principio a fin.
CREATE OR REPLACE FUNCTION public.solicitar_turno_ventanilla(p_modulo_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador      UUID;
    v_operador_fila usuarios%ROWTYPE;
    v_modulo        modulos%ROWTYPE;
    v_periodo       UUID;
    v_turno         turnos%ROWTYPE;
    v_tramite       tramites%ROWTYPE;
    v_tope          INTEGER;
    v_abiertos      INTEGER;
    v_solicitud     BIGINT;
    v_en_espera     INTEGER;
BEGIN
    -- [1] QUIÉN PREGUNTA --------------------------------------------------
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'No tiene permiso para operar turnos.'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_operador_fila FROM usuarios WHERE id = v_operador;
    IF NOT FOUND OR NOT v_operador_fila.activo THEN
        RAISE EXCEPTION 'El usuario no esta activo.'
            USING ERRCODE = '42501';
    END IF;

    -- [2] LA VENTANILLA QUE SE PIDE ---------------------------------------
    SELECT * INTO v_modulo
      FROM modulos
     WHERE id = p_modulo_id
       AND activo;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La ventanilla no existe o no esta activa.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_modulo.estado <> 'ACTIVO' THEN
        RAISE EXCEPTION 'La ventanilla % no esta operativa (estado %).',
            v_modulo.codigo, v_modulo.estado
            USING ERRCODE = 'P0001';
    END IF;

    -- [3] DERECHO DEL OPERADOR SOBRE ESA VENTANILLA -------------------------
    -- El operador tiene que estar asignado a la ventanilla que pide. Sin
    -- esto, un operador podría pedir turnos para la de otro.
    IF v_operador_fila.modulo_id IS DISTINCT FROM v_modulo.id
       AND NOT EXISTS (
            SELECT 1 FROM roles r
             WHERE r.id = v_operador_fila.rol_id
               AND r.clave = 'ADMINISTRADOR'
       ) THEN
        RETURN fn_denegar(
            'SOLICITAR_TURNO_VENTANILLA', 'modulos', v_modulo.id, v_operador,
            format('El operador %s no esta asignado a la ventanilla %s.',
                   v_operador_fila.numero_empleado, v_modulo.codigo),
            jsonb_build_object('ventanilla', v_modulo.codigo)
        );
    END IF;

    -- [4] LA VENTANILLA ESTÁ OCUPADA SI TIENE UN TURNO ABIERTO ------------
    -- La pantalla tiene tres estados: disponible, atendiendo y sin
    -- disponibilidad. «Atendiendo» es tener un turno asignado, así que mientras
    -- la ventanilla tenga uno no pide otro: una ventanilla atiende a una
    -- persona a la vez.
    --
    -- El tope configurado (migración 011, `MAXIMO_TURNOS_EN_ATENCION`) se
    -- mantiene como techo: si un administrador lo bajara a 0, nadie podría
    -- pedir turnos. Con el valor por defecto (3) quien decide es la regla de
    -- arriba, que es la que exige la pantalla.
    SELECT COALESCE(
        (SELECT NULLIF(btrim(valor), '')::INTEGER
           FROM configuracion
          WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'),
        3
    ) INTO v_tope;

    SELECT COUNT(*) INTO v_abiertos
      FROM turnos
     WHERE modulo_id = v_modulo.id
       AND estado IN ('CALLED', 'SERVING');

    IF v_abiertos >= 1 OR v_tope <= 0 THEN
        RAISE EXCEPTION
            'La ventanilla % esta atendiendo un turno. Termino o cancele antes de pedir otro.',
            v_modulo.codigo
            USING ERRCODE = 'P0001';
    END IF;

    IF v_abiertos >= v_tope THEN
        RAISE EXCEPTION
            'La ventanilla % ya tiene % turnos sin cerrar (maximo %). Atienda o cancele uno antes de pedir otro.',
            v_modulo.codigo, v_abiertos, v_tope
            USING ERRCODE = 'P0001';
    END IF;

    -- [5] EL PERIODO Y LA PETICIÓN ------------------------------------------
    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    IF v_periodo IS NULL THEN
        RAISE EXCEPTION 'No hay periodo operativo abierto.'
            USING ERRCODE = 'P0001';
    END IF;

    -- Un candado por periodo: serializa el reparto entero. Así el «orden de
    -- las solicitudes que el sistema establece» es único y no depende del
    -- azar de quién llegó antes al bloqueo de una fila.
    PERFORM pg_advisory_xact_lock(4242::int, hashtext(v_periodo::text));

    -- La petición queda registrada como PENDIENTE. Con esto, una petición
    -- simultánea ve a la otra y el reparto equitativo tiene con qué trabajar.
    -- Si esta ventanilla ya tenía una petición pendiente, no se duplica.
    SELECT id INTO v_solicitud
      FROM solicitudes_ventanilla
     WHERE periodo_operativo_id = v_periodo
       AND modulo_id = v_modulo.id
       AND operador_id = v_operador
     ORDER BY id
     LIMIT 1;

    IF v_solicitud IS NULL THEN
        INSERT INTO solicitudes_ventanilla (periodo_operativo_id, modulo_id, operador_id)
        VALUES (v_periodo, v_modulo.id, v_operador)
        RETURNING id INTO v_solicitud;
    END IF;

    -- [6] EL REPARTO ---------------------------------------------------------
    -- Se reparte TODO lo que se pueda: si hay más peticiones que turnos, se
    -- sirven las que toque y las demás siguen esperando. Se sale en cuanto un
    -- reparto ya no entrega nada (0 turnos en la cola o nadie esperando):
    -- el acumulado NO sirve para la condición de salida, porque una vez que
    -- sube de 0 no vuelve a bajar y el bucle no terminaría nunca.
    LOOP
        EXIT WHEN public.fn_repartir_turnos_ventanilla(v_periodo) = 0;
    END LOOP;

    -- [7] ¿ME TOCÓ A MÍ? ---------------------------------------------------
    -- La petición se borra cuando se sirve. Así que mi turno es el que se
    -- asignó a MI ventanilla con el `atendido_por` mío y que todavía sigue
    -- abierto: si la equitable reparto se lo llevó a otra ventanilla, este
    -- SELECT no lo encuentra y la respuesta dice que seguimos en la cola.
    SELECT * INTO v_turno
      FROM turnos t
     WHERE t.modulo_id = v_modulo.id
       AND t.atendido_por = v_operador
       AND t.estado IN ('CALLED', 'SERVING')
     ORDER BY t.llamado_en DESC
     LIMIT 1;

    -- [8] RESPUESTA ----------------------------------------------------------
    SELECT count(*) INTO v_en_espera
      FROM turnos
     WHERE periodo_operativo_id = v_periodo
       AND estado = 'WAITING';

    IF v_turno IS NULL THEN
        -- Mi petición sigue esperando: no hay turnos suficientes para todas
        -- las ventanillas que han pedido, o esta no era su turno por
        -- equitatividad.
        RETURN jsonb_build_object(
            'ok',            true,
            'servido',       false,
            'en_espera',     v_en_espera,
            'modulo_codigo', v_modulo.codigo,
            'motivo',        CASE
                                 WHEN v_en_espera = 0
                                   THEN 'No hay turnos pendientes.'
                                 ELSE 'Su ventanilla esta en la cola: hay otras esperando antes.'
                             END
        );
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;

    RETURN jsonb_build_object(
        'ok',                 true,
        'servido',            true,
        'turno_id',           v_turno.id,
        'codigo_turno',       v_turno.codigo,
        'folio',              v_turno.folio,
        'clave_tramite',      v_tramite.clave,
        'denominacion_tramite', v_tramite.denominacion,
        'modulo_id',          v_turno.modulo_id,
        'modulo_codigo',      v_modulo.codigo,
        'en_espera',          v_en_espera,
        'llamado_en',         v_turno.llamado_en
    );
END;
$$;

COMMENT ON FUNCTION public.solicitar_turno_ventanilla(uuid) IS
  'Pide el siguiente turno para una ventanilla. Asignacion atomica, FIFO global, sin saltos, con reparto equitativo entre las ventanillas que esperan (mig 37).';

-- ---------------------------------------------------------------------------
-- 5. REPARTO AUTOMÁTICO AL EMITIR UN TURNO NUEVO
-- ---------------------------------------------------------------------------
-- Si hay una ventanilla esperando y entra un turno nuevo, se le entrega.
--
-- Sin esto, una petición quedaría dormida hasta que el operador pulsara otra
-- vez. Con el disparador, la cola se mueve sola: es lo que significa «cola».
--
-- No cambia lo que hace Recepción: sigue emitiendo el mismo turno. Lo que
-- cambia es que, si alguien estaba esperando, ese turno se le asigna.
CREATE OR REPLACE FUNCTION public.fn_trigger_repartir_ventanilla()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'WAITING' THEN
        PERFORM public.fn_repartir_turnos_ventanilla(NEW.periodo_operativo_id);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_repartir_ventanilla ON public.turnos;
CREATE TRIGGER trg_repartir_ventanilla
    AFTER INSERT ON public.turnos
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trigger_repartir_ventanilla();

COMMENT ON FUNCTION public.fn_trigger_repartir_ventanilla() IS
  'Reparte el turno recien emitido a una ventanilla que estuviera esperando (mig 37).';

-- ---------------------------------------------------------------------------
-- 6. LO QUE VE EL OPERADOR
-- ---------------------------------------------------------------------------
-- Una sola lectura con las dos cosas que la pantalla pinta: la cola global y
-- el estado de cada ventanilla. Una sola foto coherente.
CREATE OR REPLACE FUNCTION public.estado_ventanillas()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_periodo  UUID;
    v_cola     JSONB;
    v_vent     JSONB;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'No tiene permiso para ver la cola de ventanillas.'
            USING ERRCODE = '42501';
    END IF;

    SELECT id INTO v_periodo
      FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC
     LIMIT 1;

    -- La cola, en el MISMO orden en que se entrega (RN-017): lo que se ve
    -- es lo que se llama.
    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_cola
      FROM (
        SELECT jsonb_build_object(
            'turno_id',             t.id,
            'codigo_turno',         t.codigo,
            'folio',                t.folio,
            'clave_tramite',        tr.clave,
            'denominacion_tramite', tr.denominacion,
            'prioridad',            t.prioridad,
            'posicion',             row_number() OVER (
                                    ORDER BY CASE t.prioridad
                                                WHEN 'URGENTE' THEN 1
                                                WHEN 'PREFERENTE' THEN 2
                                                ELSE 3 END,
                                             t.creado_en, t.id),
            'posicion_llegada',     row_number() OVER (ORDER BY t.creado_en, t.id),
            'creado_en',            t.creado_en
        ) AS fila
        FROM turnos t
        JOIN tramites tr ON tr.id = t.tramite_id
        WHERE t.estado = 'WAITING'
          AND t.periodo_operativo_id = v_periodo
      ) s;

    -- Las ventanillas: una por módulo, con su turno en curso y su contador
    -- de equidad.
    --
    -- El turno en curso se toma con LATERAL y `ORDER BY llamado_en DESC
    -- LIMIT 1`: así cada módulo sale UNA sola fila aunque, por el camino
    -- antiguo de la consola, tuviera más de un turno abierto. La pantalla
    -- pinta contenedores, no tablas, y un contenedor duplicado sería un bug
    -- de interfaz.
    SELECT coalesce(jsonb_agg(fila), '[]'::jsonb) INTO v_vent
      FROM (
        SELECT jsonb_build_object(
            'modulo_id',            m.id,
            'codigo',               m.codigo,
            'denominacion',         m.denominacion,
            'estado',               m.estado,
            'activo',               m.activo,
            -- Los tres estados que pide la pantalla, decididos aquí y no en
            -- JavaScript: así todas las ventanillas ven lo mismo.
            'estado_ventanilla',    CASE
                                        WHEN NOT (m.activo AND m.estado = 'ACTIVO')
                                            THEN 'SIN_DISPONIBILIDAD'
                                        WHEN a.turno_id IS NOT NULL
                                            THEN 'ATENDIENDO'
                                        ELSE 'DISPONIBLE'
                                    END,
            'disponible',           (m.activo AND m.estado = 'ACTIVO'
                                      AND a.turno_id IS NULL),
            'ultima_asignacion_en', m.ultima_asignacion_en,
            'turno_id',             a.turno_id,
            'turno_codigo',         a.codigo,
            'turno_estado',         a.estado,
            'turno_clave_tramite',  tr.clave,
            'turno_denominacion_tramite', tr.denominacion,
            'turno_llamado_en',     a.llamado_en,
            'turno_inicio_atencion', a.inicio_atencion,
            'minutos_en_ventanilla', CASE
                WHEN a.llamado_en IS NULL THEN NULL
                ELSE floor(extract(epoch FROM (now() - a.llamado_en)) / 60)::int
            END,
            'operador_nombres',     u.nombres
        ) AS fila
        FROM modulos m
        LEFT JOIN LATERAL (
            SELECT t.id AS turno_id, t.codigo, t.estado, t.tramite_id,
                   t.llamado_en, t.inicio_atencion, t.atendido_por
              FROM turnos t
             WHERE t.modulo_id = m.id
               AND t.estado IN ('CALLED', 'SERVING')
             ORDER BY t.llamado_en DESC NULLS LAST, t.id
             LIMIT 1
        ) a ON true
        LEFT JOIN tramites tr ON tr.id = a.tramite_id
        LEFT JOIN usuarios u ON u.id = a.atendido_por
        ORDER BY m.codigo
      ) s;

    RETURN jsonb_build_object(
        'ok',          true,
        'periodo_id',  v_periodo,
        'cola',        v_cola,
        'ventanillas', v_vent
    );
END;
$$;

COMMENT ON FUNCTION public.estado_ventanillas() IS
  'La cola global (en el orden real de llamada RN-017) y el estado de cada ventanilla, en una sola lectura (mig 37).';

-- ---------------------------------------------------------------------------
-- 7. PERMISOS
-- ---------------------------------------------------------------------------
-- PostgreSQL da EXECUTE a PUBLIC en toda función nueva: hay que revocarlo
-- explícitamente y darlo solo a quien corresponde.
REVOKE ALL ON FUNCTION public.solicitar_turno_ventanilla(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.solicitar_turno_ventanilla(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.solicitar_turno_ventanilla(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_repartir_turnos_ventanilla(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_trigger_repartir_ventanilla() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_trigger_repartir_ventanilla() FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_trigger_repartir_ventanilla() TO authenticated;

REVOKE ALL ON FUNCTION public.estado_ventanillas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.estado_ventanillas() FROM anon;
GRANT EXECUTE ON FUNCTION public.estado_ventanillas() TO authenticated;

-- La tabla de peticiones es interna: solo la tocan las funciones de arriba.
REVOKE ALL ON public.solicitudes_ventanilla FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
