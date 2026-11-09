-- ===========================================================================
-- 012 — Consulta de un turno por su código (recepción)
-- ===========================================================================
--
-- PROBLEMA QUE RESUELVE
-- Al emitir por lotes salen decenas de papeles idénticos, todos en WAITING y
-- sin dueño. En recepción alguien llega con uno en la mano y hay que saber de
-- inmediato: ¿este papel todavía vale, o alguien ya lo tomó?
--
-- No interesa QUIÉN lo tiene, solo si está tomado. Con dos estados basta.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ SE BUSCA POR `codigo` Y NO POR `folio`
-- ---------------------------------------------------------------------------
-- El folio NO es único. El índice real de la tabla es:
--
--   uq_turnos_periodo_tramite_folio (periodo_operativo_id, tramite_id, folio)
--
-- Es decir: cada TRÁMITE lleva su propio contador. En el mismo día «folio 1»
-- existe tres veces (uno por trámite), y en el periodo abierto había 50
-- folios repetidos. Buscar por folio devolvería uno al azar.
--
-- El `codigo` (`C-184`, `G-012`) sí es único en todo el sistema: lo es también
-- el que va dentro del QR. Por eso el papel debe imprimir el código, y la
-- consulta se hace por él.
--
-- ---------------------------------------------------------------------------
-- POR QUÉ NO UNA MARCA MANUAL
-- No hace falta guardar nada nuevo. El estado YA dice si tiene dueño:
--
--   WAITING                               → nadie lo ha tomado → disponible
--   CALLED / SERVING / COMPLETED / SKIPPED / CANCELLED → alguien lo tomó
--
-- Una casilla que alguien tenga que marcar se olvida el día que hay prisa, y
-- entonces la marca miente. Derivarlo del estado no puede mentir.
--
-- SKIPPED y CANCELLED cuentan como «con dueño» a propósito: ese papel NO vale.
-- Si se marcaran como disponibles, alguien podría reutilizar un turno que ya
-- se omitió o se anuló.
-- ===========================================================================

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
    -- Se acepta «C-184», «c-184», «c184» y « C-184 »: quien lo teclea a mano
    -- desde un papel no va a recordar mayúsculas ni guiones.
    v_limpio text;
BEGIN
    v_limpio := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));

    -- Sin nada que buscar se devuelve vacío en vez de fallar, para que el
    -- buscador muestre «no encontrado» y no un error rojo en pantalla.
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
         * La fuente es el estado, no `atendido_por`: un turno SKIPPED nunca
         * tuvo trabajador asignado pero su papel tampoco vale. Si se mirara
         * solo `atendido_por`, un turno omitido aparecería como disponible y
         * alguien podría reutilizarlo.
         */
        (t.estado <> 'WAITING') AS tiene_dueno,
        /*
         * Los apellidos viven en `apellidos` (normalizado) y `usuarios` solo
         * guarda sus ids. Se replica la unión de `vista_turnos_actuales` para
         * que el nombre salga idéntico aquí y allí.
         */
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
    /*
     * El código puede repetirse ENTRE PERIODOS (los contadores se reinician
     * cada día), así que se ordena por fecha para quedarse con el de hoy.
     *
     * `p.fecha` y no `t.periodo_operativo_id`: el id es un uuid y ordenarlo no
     * significa nada (daría un periodo al azar). Primero el periodo abierto,
     * que es el vigente.
     */
    JOIN periodos_operativos p ON p.id = t.periodo_operativo_id
    WHERE upper(regexp_replace(t.codigo, '[^A-Za-z0-9]', '', 'g')) = v_limpio
    ORDER BY (p.estado = 'ABIERTO') DESC, p.fecha DESC, t.creado_en DESC
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION consultar_turno_por_codigo(text) IS
    'Dado el código impreso en un papel (C-184), dice si el turno ya tiene dueño o sigue disponible.';
COMMENT ON COLUMN turnos.folio IS
    'Contador POR TRAMITE dentro del periodo (uq_turnos_periodo_tramite_folio): NO es único por día. Para identificar un papel hay que usar `codigo`.';

GRANT EXECUTE ON FUNCTION consultar_turno_por_codigo(text) TO authenticated, anon;

-- Recarga el esquema de PostgREST para que la función sea visible de inmediato.
NOTIFY pgrst, 'reload schema';
