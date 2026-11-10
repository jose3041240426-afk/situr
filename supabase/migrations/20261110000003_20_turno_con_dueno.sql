-- ===========================================================================
-- 020 — El papel ya tiene dueño (marca manual del operador)
-- ===========================================================================
--
-- PROBLEMA
-- De un lote salen doce papeles iguales, todos en WAITING. En recepción el
-- operador entrega uno a una persona y ese papel, desde ese momento, ya tiene
-- dueño… pero el turno sigue en WAITING hasta que alguien lo llama, así que
-- nada en la pantalla lo distingue de los otros once que siguen en el montón.
--
-- La consulta por código (`consultar_turno_por_codigo`) deriva «tiene dueño»
-- del estado, y para el papel que ya está en la mano de alguien eso es falso.
--
-- SOLUCIÓN
-- Una marca manual y de un solo sentido: `turnos.reclamado_en`.
--   · Se pone al pulsar la casilla que hay detrás del código del turno en la
--     cola de espera (un clic, una vez; no se puede desmarcar).
--   · No cambia el estado del turno ni el orden de llamada: es información,
--     no una transición de la máquina de estados.
--   · Queda en auditoría, para saber quién la puso y cuándo.
--
-- POR QUÉ NO BASTA CON EL ESTADO
-- El estado dice si el turno fue llamado, no si el papel salió del montón.
-- Son dos hechos distintos: un papel entregado puede esperar media hora en
-- WAITING, y un papel sin dueño puede acabar omitido sin que nadie lo tomara.
-- ===========================================================================

BEGIN;

ALTER TABLE turnos
    ADD COLUMN IF NOT EXISTS reclamado_en TIMESTAMPTZ;

COMMENT ON COLUMN turnos.reclamado_en IS
    'Cuando el operador marcó que el papel impreso ya se entregó a una persona (RF-031). NULL = sigue en el montón.';

-- ---------------------------------------------------------------------------
-- La cola de espera lo expone. `CREATE OR REPLACE VIEW` solo admite añadir
-- columnas AL FINAL: por eso `reclamado_en` va la última.
-- ---------------------------------------------------------------------------
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
        ) AS posicion_global
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
    o.reclamado_en
FROM orden o
INNER JOIN tramites tr ON tr.id = o.tramite_id;

COMMENT ON VIEW vista_cola_espera IS
    'Turnos en espera con su posicion por tramite+periodo (RN-014), el orden de prioridad (RN-017) y si el papel ya se entrego (reclamado_en).';

-- ---------------------------------------------------------------------------
-- RPC: marcar el papel como entregado.
--
-- Es idempotente: marcarlo dos veces no cambia la fecha de la primera vez ni
-- falla. La marca es de un solo sentido a propósito: deshacerla exigiría
-- saber si el papel volvió al montón, y eso nadie lo registra.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION marcar_turno_reclamado(p_turno_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador UUID;
    v_turno    turnos%ROWTYPE;
    v_ahora    TIMESTAMPTZ;
BEGIN
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'El rol actual no puede marcar turnos (RN-007).'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE id = p_turno_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El turno no existe.' USING ERRCODE = 'P0002';
    END IF;

    /*
     * Si el turno ya salió de la cola (llamado, atendido, omitido…), su papel
     * hace tiempo que no está en el montón: marcarlo no aporta nada y podría
     * confundir la lectura. Se devuelve el estado sin tocarlo.
     */
    IF v_turno.estado <> 'WAITING' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'turno_id', v_turno.id,
            'codigo_turno', v_turno.codigo,
            'reclamado_en', v_turno.reclamado_en,
            'ya_reclamado', true,
            'estado', v_turno.estado
        );
    END IF;

    IF v_turno.reclamado_en IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'turno_id', v_turno.id,
            'codigo_turno', v_turno.codigo,
            'reclamado_en', v_turno.reclamado_en,
            'ya_reclamado', true,
            'estado', v_turno.estado
        );
    END IF;

    -- `clock_timestamp()` y no `now()`: `now()` es la hora de inicio de la
    -- transacción, y aquí lo que interesa es el instante del clic.
    v_ahora := clock_timestamp();

    UPDATE turnos
       SET reclamado_en = v_ahora
     WHERE id = v_turno.id;

    PERFORM registrar_auditoria(
        v_operador, 'MARCAR_TURNO_RECLAMADO', 'turnos', v_turno.id::text, 'EXITO',
        jsonb_build_object('codigo', v_turno.codigo)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'turno_id', v_turno.id,
        'codigo_turno', v_turno.codigo,
        'reclamado_en', v_ahora,
        'ya_reclamado', false,
        'estado', v_turno.estado
    );
END;
$$;

COMMENT ON FUNCTION marcar_turno_reclamado(UUID) IS
    'Marca que el papel impreso de un turno ya se entrego a una persona. Idempotente y de un solo sentido.';

-- ---------------------------------------------------------------------------
-- La consulta por código tiene que decir lo mismo que la cola: un papel
-- marcado como entregado ya tiene dueño, aunque el turno siga en WAITING.
-- Se reemplaza la función de la migración 012 cambiando solo esa condición.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consultar_turno_por_codigo(p_codigo text)
RETURNS TABLE (
    turno_id             uuid,
    codigo_turno         text,
    folio                integer,
    estado               text,
    tiene_dueno          boolean,
    nombre_trabajador    text,
    codigo_modulo        text,
    clave_tramite        text,
    denominacion_tramite text,
    creado_en            timestamptz,
    llamado_en           timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limpio text;
BEGIN
    v_limpio := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));

    IF v_limpio !~ '^[A-Z][0-9]+$' THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        t.id,
        t.codigo,
        t.folio,
        t.estado::text,
        /*
         * Dos fuentes, no una: el estado (si salió de la cola) y la marca
         * manual (si el papel ya se entregó). Antes solo se miraba el estado,
         * y un papel entregado hace un minuto decía «Disponible».
         */
        (t.estado <> 'WAITING' OR t.reclamado_en IS NOT NULL) AS tiene_dueno,
        btrim(concat(u.nombres, ' ', a_pat.apellido, ' ', coalesce(a_mat.apellido, ''))),
        m.codigo,
        tr.clave,
        tr.denominacion,
        t.creado_en,
        t.llamado_en
    FROM turnos t
    JOIN tramites tr ON tr.id = t.tramite_id
    LEFT JOIN modulos m ON m.id = t.modulo_id
    LEFT JOIN usuarios u ON u.id = t.atendido_por
    LEFT JOIN apellidos a_pat ON a_pat.id = u.apellido_paterno_id
    LEFT JOIN apellidos a_mat ON a_mat.id = u.apellido_materno_id
    JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
    WHERE upper(regexp_replace(t.codigo, '[^A-Za-z0-9]', '', 'g')) = v_limpio
    ORDER BY (p.estado = 'ABIERTO') DESC, p.fecha DESC, t.creado_en DESC
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION consultar_turno_por_codigo(text) IS
    'Dado el codigo impreso en un papel, dice si ya tiene dueno (fuera de la cola o marcado como entregado) o sigue disponible.';

REVOKE ALL ON FUNCTION marcar_turno_reclamado(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marcar_turno_reclamado(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
