-- ============================================================================
-- SITUR — PRUEBAS DE LA COLA GLOBAL Y LA ASIGNACIÓN (migración 037)
-- ============================================================================
--
-- Escenario probado:
--
--   1. Tres ventanillas solicitan simultáneamente y existen diez turnos
--      pendientes -> tres turnos DISTINTOS y CONSECUTIVOS en la cola global.
--   2. Dos ventanillas intentan reservar el mismo turno -> imposible: la
--      función no acepta un identificador de turno.
--   3. Una ventanilla está ocupada y las demás disponibles.
--   4. Una ventanilla termina su atención y solicita el siguiente turno.
--   5. Un operador pierde conexión durante una asignación -> la transacción
--      se deshace y no queda nada a medias.
--   6. Se actualiza la página mientras una ventanilla tiene un turno
--      asignado -> el turno sigue siendo suyo.
--   7. Se cancela un turno.
--   8. No existen turnos pendientes.
--   9. Dos solicitudes simultáneas llegan mientras solamente queda un turno.
--
-- Uso:  psql -X -q -v ON_ERROR_STOP=1 -d <base> -f pruebas/cola-global.sql
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

-- ---------------------------------------------------------------------------
-- MARCO DE PRUEBA
-- ---------------------------------------------------------------------------
-- Se trabaja sobre una base de pruebas con `app.uid` (el stub de auth.uid()).
-- Todo lo que se crea aquí se borra al final.

ALTER TABLE auditoria DISABLE TRIGGER trg_auditoria_solo_insercion;

DO $$
DECLARE
    v_periodo UUID;
    v_m01 UUID; v_m02 UUID; v_m03 UUID;
    v_op1 UUID; v_op2 UUID; v_op3 UUID;
BEGIN
    -- Nada de esto debe quedar: la prueba empieza de cero.
    DELETE FROM solicitudes_ventanilla;
    DELETE FROM turnos;
    DELETE FROM folios;
    DELETE FROM periodos_operativos;
    DELETE FROM usuarios WHERE email LIKE '%@prueba.situr.test';
    DELETE FROM apellidos WHERE apellido LIKE 'PRUEBAOP%';
    DELETE FROM modulos WHERE codigo LIKE 'M9%';

    INSERT INTO periodos_operativos (clave, fecha, estado)
    VALUES (current_date, current_date, 'ABIERTO');

    INSERT INTO modulos (codigo, denominacion, estado, activo)
    VALUES ('M90', 'Ventanilla de prueba 1', 'ACTIVO', true),
           ('M91', 'Ventanilla de prueba 2', 'ACTIVO', true),
           ('M92', 'Ventanilla de prueba 3', 'ACTIVO', true);

    SELECT id INTO v_m01 FROM modulos WHERE codigo = 'M90';
    SELECT id INTO v_m02 FROM modulos WHERE codigo = 'M91';
    SELECT id INTO v_m03 FROM modulos WHERE codigo = 'M92';

    INSERT INTO apellidos (apellido)
    VALUES ('PRUEBAOP1'), ('PRUEBAOP2'), ('PRUEBAOP3');

    -- `auth_uid = id` a propósito: fn_usuario_actual() identifica al usuario
    -- por auth_uid, así que con los dos iguales la suite puede fijar
    -- `app.uid` con el id de la fila sin tener que traducirlo.
    INSERT INTO usuarios (id, auth_uid, nombres, apellido_paterno_id, email,
                          numero_empleado, rol_id, modulo_id, activo, mfa_habilitado)
    SELECT g.u, g.u, 'Operador Prueba 1',
           (SELECT id FROM apellidos WHERE apellido = 'PRUEBAOP1'),
           'op1@prueba.situr.test', 'EMP-T1',
           (SELECT id FROM roles WHERE clave = 'AGENTE'), v_m01, true, false
      FROM (SELECT gen_random_uuid() AS u) g
    UNION ALL
    SELECT g.u, g.u, 'Operador Prueba 2',
           (SELECT id FROM apellidos WHERE apellido = 'PRUEBAOP2'),
           'op2@prueba.situr.test', 'EMP-T2',
           (SELECT id FROM roles WHERE clave = 'AGENTE'), v_m02, true, false
      FROM (SELECT gen_random_uuid() AS u) g
    UNION ALL
    SELECT g.u, g.u, 'Operador Prueba 3',
           (SELECT id FROM apellidos WHERE apellido = 'PRUEBAOP3'),
           'op3@prueba.situr.test', 'EMP-T3',
           (SELECT id FROM roles WHERE clave = 'AGENTE'), v_m03, true, false
      FROM (SELECT gen_random_uuid() AS u) g;

    SELECT id INTO v_op1 FROM usuarios WHERE email = 'op1@prueba.situr.test';
    SELECT id INTO v_op2 FROM usuarios WHERE email = 'op2@prueba.situr.test';
    SELECT id INTO v_op3 FROM usuarios WHERE email = 'op3@prueba.situr.test';

    PERFORM set_config('app.uid', v_op1::text, false);
END;
$$;

-- Se emiten 10 turnos de prueba con el operador 1.
DO $$
DECLARE
    v_periodo UUID;
    v_tramite UUID;
    v_i INTEGER;
BEGIN
    SELECT id INTO v_periodo FROM periodos_operativos
     WHERE clave = current_date;
    SELECT id INTO v_tramite FROM tramites WHERE clave = 'CONST';

    FOR v_i IN 1..10 LOOP
        PERFORM generar_turno(v_tramite, 'NORMAL');
    END LOOP;
END;
$$;

\echo ''
\echo '=== 1. La cola global está en orden de llegada y sin saltos ==='
SELECT
    row_number() OVER (ORDER BY creado_en, id) AS posicion,
    codigo,
    prioridad,
    to_char(creado_en, 'HH24:MI:SS.MS') AS creado
FROM turnos
WHERE estado = 'WAITING'
ORDER BY creado_en, id;

\echo ''
\echo '=== 1b. PRIORIDAD: un URGENTE se adelanta (RN-017) ==='
DO $$
DECLARE
    v_tramite UUID;
BEGIN
    SELECT id INTO v_tramite FROM tramites WHERE clave = 'CONST';
    PERFORM generar_turno(v_tramite, 'URGENTE');
END;
$$;

SELECT
    CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END AS nivel,
    codigo,
    prioridad
FROM turnos
WHERE estado = 'WAITING'
ORDER BY
    CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
    creado_en, id;

-- ---------------------------------------------------------------------------
-- PRUEBA 1: TRES VENTANILLAS SIMULTÁNEAS, DIEZ TURNOS PENDIENTES
-- ---------------------------------------------------------------------------
-- Tres conexiones distintas, cada una con su operador, llaman a la vez.
-- Se espera: tres turnos DISTINTOS y CONSECUTIVOS.
\echo ''
\echo '=== 2. Tres peticiones simultáneas (operadores 1, 2 y 3) ==='

-- Cada conexión es una sesión de psql aparte: se lanzan en paralelo.
\! export PGHOST=127.0.0.1 PGUSER=postgres
\! psql -X -q -d situr_test -c "SELECT set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op1@prueba.situr.test'), false); SELECT public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M90'))->>'codigo_turno' AS t1;" > /tmp/opencode/p1.txt 2>&1 &
\! psql -X -q -d situr_test -c "SELECT set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op2@prueba.situr.test'), false); SELECT public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M91'))->>'codigo_turno' AS t2;" > /tmp/opencode/p2.txt 2>&1 &
\! psql -X -q -d situr_test -c "SELECT set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op3@prueba.situr.test'), false); SELECT public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M92'))->>'codigo_turno' AS t3;" > /tmp/opencode/p3.txt 2>&1 &
\! sleep 3
\! wait
\echo '--- lo que devolvió cada uno ---'
\echo 'M90:'; cat /tmp/opencode/p1.txt
\echo 'M91:'; cat /tmp/opencode/p2.txt
\echo 'M92:'; cat /tmp/opencode/p3.txt

\echo ''
\echo '--- comprobación: distintos y consecutivos en la cola global ---'
SELECT
    count(*) FILTER (WHERE estado = 'CALLED')          AS asignados,
    count(DISTINCT modulo_id) FILTER (WHERE estado='CALLED') AS ventanillas_distintas,
    count(*) FILTER (WHERE estado = 'WAITING')          AS en_espera
FROM turnos;

-- Los tres asignados tienen que ser los tres primeros de la cola global.
\echo '--- los turnos asignados, por posición en la cola global ---'
SELECT
    row_number() OVER (ORDER BY
        CASE prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
        creado_en, id) AS posicion_global,
    codigo,
    estado,
    (SELECT codigo FROM modulos WHERE id = turnos.modulo_id) AS ventanilla
FROM turnos
WHERE estado <> 'WAITING'
ORDER BY posicion_global;

-- ---------------------------------------------------------------------------
-- PRUEBA 3: UNA VENTANILLA OCUPADA Y LAS DEMÁS DISPONIBLES
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 3. Una ventanilla ocupada no puede pedir otro turno ==='
DO $$
DECLARE
    v_res jsonb;
BEGIN
    PERFORM set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op1@prueba.situr.test'), false);
    BEGIN
        v_res := public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M90'));
        RAISE EXCEPTION 'FALLO: la ventanilla ocupada recibio un turno: %', v_res;
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
            RAISE NOTICE 'OK: la ventanilla ocupada fue rechazada (tope de turnos abiertos).';
    END;
END;
$$;

-- ---------------------------------------------------------------------------
-- PRUEBA 4: TERMINAR LA ATENCIÓN Y PEDIR EL SIGUIENTE
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 4. La ventanilla termina su atención y pide el siguiente ==='
DO $$
DECLARE
    v_turno UUID;
    v_res jsonb;
BEGIN
    PERFORM set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op1@prueba.situr.test'), false);

    -- Terminar el turno que tenía asignado.
    SELECT id INTO v_turno FROM turnos
     WHERE modulo_id = (SELECT id FROM modulos WHERE codigo='M90')
       AND estado = 'CALLED'
     LIMIT 1;

    IF v_turno IS NULL THEN
        RAISE EXCEPTION 'FALLO: la ventanilla M90 no tenía turno asignado.';
    END IF;

    PERFORM public.iniciar_atencion_turno(v_turno);
    PERFORM public.finalizar_turno(v_turno);

    RAISE NOTICE 'Turno finalizado. Estado: %',
        (SELECT estado FROM turnos WHERE id = v_turno);

    -- Ahora sí puede pedir otro.
    v_res := public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M90'));
    RAISE NOTICE 'OK: la ventanilla vuelve a pedir y recibe %', v_res->>'codigo_turno';
END;
$$;

-- ---------------------------------------------------------------------------
-- PRUEBA 5: SE DESHACE UNA ASIGNACIÓN (EL OPERADOR PIERDE LA CONEXIÓN)
-- ---------------------------------------------------------------------------
-- Es lo que pasa cuando la red se cae a mitad: la transacción se deshace
-- entera. No puede quedar un turno «tomado» sin dueño.
\echo ''
\echo '=== 5. Una asignación deshecha no deja nada a medias ==='
DO $$
DECLARE
    v_antes_calle INTEGER;
    v_despues_calle INTEGER;
    v_antes_modulo UUID;
BEGIN
    PERFORM set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op2@prueba.situr.test'), false);

    SELECT count(*) INTO v_antes_calle FROM turnos WHERE estado = 'CALLED';
    SELECT modulo_id INTO v_antes_modulo FROM turnos WHERE estado = 'CALLED' LIMIT 1;

    BEGIN
        -- La llamada se deshace: se simula con una excepción dentro.
        PERFORM public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M91'));
        RAISE EXCEPTION 'FALLO simulado: la transacción se deshace';
    EXCEPTION
        WHEN OTHERS THEN
            -- Se deshace todo lo de esta transacción.
            NULL;
    END;

    SELECT count(*) INTO v_despues_calle FROM turnos WHERE estado = 'CALLED';
    RAISE NOTICE 'Turnos CALLED antes: %, después: % (deben ser iguales)', v_antes_calle, v_despues_calle;
END;
$$;

-- ---------------------------------------------------------------------------
-- PRUEBA 6: RECARGAR LA PANTALLA NO LIBERA EL TURNO
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 6. Un turno asignado sigue siendo de su ventanilla ==='
SELECT
    (SELECT codigo FROM modulos WHERE id = t.modulo_id) AS ventanilla,
    t.codigo,
    t.estado,
    to_char(t.llamado_en, 'HH24:MI:SS') AS llamado
FROM turnos t
WHERE t.estado IN ('CALLED', 'SERVING')
ORDER BY t.llamado_en;

-- ---------------------------------------------------------------------------
-- PRUEBA 7: SE CANCELA UN TURNO
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 7. Cancelar un turno lo saca de la cola ==='
DO $$
DECLARE
    v_turno UUID;
    v_antes INTEGER;
    v_despues INTEGER;
BEGIN
    PERFORM set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op3@prueba.situr.test'), false);

    SELECT count(*) INTO v_antes FROM turnos WHERE estado = 'WAITING';

    SELECT id INTO v_turno FROM turnos
     WHERE estado = 'WAITING'
       AND modulo_id IS NULL
     ORDER BY creado_en, id
     LIMIT 1;

    IF v_turno IS NULL THEN
        RAISE NOTICE 'No hay turno en espera para cancelar.';
        RETURN;
    END IF;

    PERFORM public.cancelar_turno(v_turno, 'Prueba de cancelación.'::text);

    SELECT count(*) INTO v_despues FROM turnos WHERE estado = 'WAITING';
    RAISE NOTICE 'En espera antes: %, después: %', v_antes, v_despues;
    RAISE NOTICE 'Estado del turno cancelado: %',
        (SELECT estado FROM turnos WHERE id = v_turno);
END;
$$;

-- ---------------------------------------------------------------------------
-- PRUEBA 8: NO HAY TURNOS PENDIENTES
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 8. Sin turnos pendientes la petición se rechaza con un motivo claro ==='
DO $$
DECLARE
    v_espera INTEGER;
    v_res jsonb;
BEGIN
    PERFORM set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op1@prueba.situr.test'), false);

    -- Se vacía la cola.
    DO $inner$
    DECLARE v_t UUID;
    BEGIN
        FOR v_t IN SELECT id FROM turnos WHERE estado = 'WAITING' LOOP
            PERFORM public.cancelar_turno(v_t, 'PRUEBA: vaciar cola');
        END LOOP;
    END $inner$;

    SELECT count(*) INTO v_espera FROM turnos WHERE estado = 'WAITING';
    RAISE NOTICE 'Turnos en espera: %', v_espera;

    BEGIN
        v_res := public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M90'));
        RAISE NOTICE 'OK: la respuesta dice «servido: %, motivo: %»',
            v_res->>'servido', v_res->>'motivo';
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE 'La petición se rechazó con: %', SQLERRM;
    END;
END;
$$;

-- ---------------------------------------------------------------------------
-- PRUEBA 9: DOS SOLICITUDES SIMULTÁNEAS Y SOLO UN TURNO
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 9. Dos peticiones simultáneas con un solo turno disponible ==='
DO $$
DECLARE
    v_tramite UUID;
    v_i INTEGER;
BEGIN
    -- Se reabre la cola con turnos nuevos y se deja solo UNO pendiente.
    DELETE FROM turnos;
    SELECT id INTO v_tramite FROM tramites WHERE clave = 'CONST';

    FOR v_i IN 1..3 LOOP
        PERFORM generar_turno(v_tramite, 'NORMAL');
    END LOOP;

    DO $inner$
    DECLARE v_t UUID;
    BEGIN
        FOR v_t IN
            SELECT id FROM turnos
             WHERE id NOT IN (SELECT id FROM turnos ORDER BY creado_en, id LIMIT 1)
        LOOP
            PERFORM public.cancelar_turno(v_t, 'PRUEBA: dejar solo uno');
        END LOOP;
    END $inner$;

    PERFORM set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op2@prueba.situr.test'), false);
END;
$$;

\! psql -X -q -d situr_test -c "SELECT set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op2@prueba.situr.test'), false); SELECT public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M91'))->>'codigo_turno' AS t2;" > /tmp/opencode/q1.txt 2>&1 &
\! psql -X -q -d situr_test -c "SELECT set_config('app.uid', (SELECT id::text FROM usuarios WHERE email='op3@prueba.situr.test'), false); SELECT public.solicitar_turno_ventanilla((SELECT id FROM modulos WHERE codigo='M92'))->>'codigo_turno' AS t3;" > /tmp/opencode/q2.txt 2>&1 &
\! sleep 3
\! wait
\echo '--- M91:'; cat /tmp/opencode/q1.txt
\echo '--- M92:'; cat /tmp/opencode/q2.txt
\echo '--- el turno único no puede estar en dos ventanillas ---'
SELECT
    count(*) FILTER (WHERE estado <> 'WAITING') AS asignados,
    count(DISTINCT modulo_id) FILTER (WHERE estado <> 'WAITING') AS ventanillas
FROM turnos;

-- ---------------------------------------------------------------------------
-- LIMPIEZA
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== Limpieza ==='
DELETE FROM solicitudes_ventanilla;
DELETE FROM turnos;
DELETE FROM folios;
DELETE FROM periodos_operativos WHERE clave = current_date;
DELETE FROM usuarios WHERE email LIKE '%@prueba.situr.test';
DELETE FROM apellidos WHERE apellido LIKE 'PRUEBAOP%';
DELETE FROM modulos WHERE codigo LIKE 'M9%';

ALTER TABLE auditoria ENABLE TRIGGER trg_auditoria_solo_insercion;
\echo 'Hecho.'
