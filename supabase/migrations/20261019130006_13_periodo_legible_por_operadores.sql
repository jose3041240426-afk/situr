-- ===========================================================================
-- 013 — El periodo operativo se puede LEER desde cualquier cuenta con sesión
-- ===========================================================================
--
-- QUÉ ESTABA MAL
-- Con la cuenta de administrador, la consola enseñaba el periodo «Abierto».
-- Al entrar con la cuenta de un operador (rol AGENTE), el mismo periodo
-- aparecía «Cerrado» aunque la jornada siguiera abierta, y con él se
-- deshabilitaban la emisión y las acciones de la cola.
--
-- No era un fallo de la interfaz. `obtenerPeriodoAbierto()` lee
-- `periodos_operativos` directamente, y la única política de esa tabla era
-- `p_admin FOR ALL ... USING (fn_es_administrador())`. Para un AGENTE, RLS
-- devuelve cero filas, `maybeSingle()` las convierte en `null`, y `null`
-- significa «no hay periodo abierto»: la consola pintaba «Cerrado».
--
-- LA REGLA NUEVA
-- Leer el periodo es parte de operar: sin saber si la jornada está abierta no
-- se puede emitir un turno. Se añade la misma política de lectura que ya
-- tienen los catálogos (`tramites`, `modulos`, `configuracion`).
--
-- La escritura NO cambia: abrir y cerrar el periodo sigue siendo de
-- administradores (RF-025), en la RLS (`p_admin` es la única política de
-- INSERT/UPDATE/DELETE) y dentro de las dos RPC, que además lo comprueban
-- con `fn_es_administrador()`.
--
-- POR QUÉ NO UNA RPC
-- La fila no tiene nada que ocultar: clave, fecha, hora de apertura, hora de
-- cierre y estado. No lleva PII ni tokens. Una función SECURITY DEFINER para
-- devolver seis columnas públicas sería una pieza más que mantener sin
-- mejorar la seguridad.
-- ===========================================================================

-- Idempotente: se puede reaplicar sin duplicar la política.
DROP POLICY IF EXISTS p_lectura ON periodos_operativos;

CREATE POLICY p_lectura ON periodos_operativos
    FOR SELECT TO authenticated
    USING (true);

COMMENT ON POLICY p_lectura ON periodos_operativos IS
    'Cualquier cuenta con sesión lee la jornada: la consola la necesita para saber si puede emitir turnos. Escribir sigue limitado a administradores por p_admin (RF-025).';
