-- ===========================================================================
-- 011 — El tope de «En atención ahora» se cuenta por OPERADOR, no por módulo
-- ===========================================================================
--
-- QUÉ ESTABA MAL
-- La regla [5] original (migración 004) bloqueaba la llamada si el MÓDULO tenía
-- cualquier turno en CALLED o SERVING:
--
--     El modulo M01 todavia tiene un turno en atencion.
--
-- Con eso el máximo real era SIEMPRE 1, aunque el límite declarado
-- (MAXIMO_TURNOS_EN_ATENCION, migración 010) fuera 3. La consola mostraba
-- «1 de 3» y el servidor rechazaba el segundo: la interfaz prometía algo que
-- la base no permitía. Era un fallo de coherencia entre las dos migraciones.
--
-- LA REGLA NUEVA
-- Se cuentan los turnos del OPERADOR, sin distinguir estado. Con el tope en 3
-- son válidos, entre otros:
--
--     3 CALLED                 ✓
--     2 SERVING + 1 CALLED     ✓
--     1 SERVING + 2 CALLED     ✓
--     3 SERVING                ✓
--     4 en cualquier mezcla    ✗ (tope)
--
-- POR QUÉ POR OPERADOR Y NO POR MÓDULO
-- El límite existe porque un operador tiene UNA ventanilla y acumular avisos
-- sin atenderlos es trabajo invisible. Dos operadores distintos en el mismo
-- módulo sí deberían poder tener sus propios turnos abiertos; contar por
-- módulo los bloqueaba entre ellos.
--
-- POR QUÉ SE REESCRIBE LA FUNCIÓN ENTERA
-- PostgreSQL no permite parchear el cuerpo de una función: `CREATE OR REPLACE`
-- la sustituye completa. Se copia la de 004 y solo cambia el bloque [5].
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- La regla [5] lee el tope de `configuracion`. La 010 crea la clave; este
-- INSERT es idempotente para que 011 pueda aplicarse sola.
-- ---------------------------------------------------------------------------
INSERT INTO configuracion (clave, nombre, valor, tipo, descripcion)
VALUES (
    'MAXIMO_TURNOS_EN_ATENCION',
    'Turnos abiertos a la vez por operador',
    '3',
    'ENTERO',
    'Turnos CALLED+SERVING que un operador puede tener abiertos. Al llegar al límite la consola bloquea «Llamar» hasta que finalice o cancele uno.'
)
ON CONFLICT (clave) DO NOTHING;

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
    v_tope        INTEGER;
    v_abiertos    INTEGER;
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

    -- [5] Tope de turnos abiertos por OPERADOR (migración 011).
    --
    -- La versión original de esta regla bloqueaba si el MÓDULO tenía algún
    -- turno CALLED o SERVING, así que el máximo real era 1 por módulo aunque
    -- el límite declarado fuera 3: la consola mostraba «1 de 3» y el servidor
    -- rechazaba el segundo.
    --
    -- Ahora se cuenta por operador y sin distinguir estado: da igual si los 3
    -- están CALLED, o 1 SERVING + 2 CALLED. Lo que no se permite es pasar de
    -- MAXIMO_TURNOS_EN_ATENCION (3 por defecto), porque un operador tiene una
    -- ventanilla y acumular avisos sin atenderlos es trabajo invisible.
    SELECT COALESCE(
        (SELECT NULLIF(btrim(valor), '')::INTEGER
           FROM configuracion
          WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'),
        3
    ) INTO v_tope;

    SELECT COUNT(*) INTO v_abiertos
      FROM turnos
     WHERE atendido_por = v_operador.id
       AND estado IN ('CALLED', 'SERVING');

    IF v_abiertos >= v_tope THEN
        RAISE EXCEPTION
            'Ya tiene % turnos abiertos (maximo %). Finalice o cancele uno antes de llamar a otro.',
            v_abiertos, v_tope
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

COMMIT;
