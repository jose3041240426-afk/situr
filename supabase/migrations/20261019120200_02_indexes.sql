-- ============================================================================
-- SITUR — MIGRACIÓN 002: ÍNDICES
-- Modelo de datos FUSIONADO v2.0
--
-- Nota sobre redundancia: PostgreSQL crea automáticamente un índice para cada
-- FOREIGN KEY que no tenga uno utilizable. TOMA_TURNO declaraba 10 índices de
-- los cuales 4 eran redundantes exactamente por esto (idx_usuarios_rol,
-- idx_ventanillas_servicio, idx_ventanillas_usuario, idx_turnos_token — este
-- último sobre una columna ya UNIQUE). Aquí solo se crean los que aportan algo
-- real: compuestos, parciales o de rango.
--
-- Todo índice listo para validar con EXPLAIN ANALYZE (DRS §7).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- USUARIOS
-- ---------------------------------------------------------------------------

-- Filtro habitual del panel de administración.
CREATE INDEX idx_usuarios_activo
    ON usuarios (activo)
    WHERE activo;

-- Localizar operadores de un módulo concreto (RG-004).
CREATE INDEX idx_usuarios_modulo
    ON usuarios (modulo_id)
    WHERE modulo_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- MODULOS
-- ---------------------------------------------------------------------------

-- RN-013: "módulos PAUSADO/FUERA_DE_SERVICIO sin nuevas asignaciones".
-- La consulta típica es WHERE estado = 'ACTIVO' AND activo.
CREATE INDEX idx_modulos_operativos
    ON modulos (estado)
    WHERE activo;

-- ---------------------------------------------------------------------------
-- TURNOS  (la tabla caliente)
-- ---------------------------------------------------------------------------

-- RN-014: posición dentro de un trámite+periodo. Cubre la lectura principal
-- de la cola y el ORDER BY prioridad/creado_en de llamar_siguiente_turno.
CREATE INDEX idx_turnos_cola
    ON turnos (periodo_operativo_id, tramite_id, estado, prioridad, creado_en);

-- Consulta del ciudadano y del administrador: "turnos de hoy".
CREATE INDEX idx_turnos_estado_fecha
    ON turnos (estado, creado_en);

-- Chequeo "¿la ventanilla tiene otro turno activo?" de llamar_siguiente.
-- (TOMA_TURNO hacía esta consulta sin índice compuesto propio.)
CREATE INDEX idx_turnos_modulo_activo
    ON turnos (modulo_id, estado)
    WHERE modulo_id IS NOT NULL
      AND estado IN ('CALLED', 'SERVING');

-- pg_cron: barrido de turnos CALLED vencidos (RF-013).
CREATE INDEX idx_turnos_llamado_pendiente
    ON turnos (llamado_en)
    WHERE estado = 'CALLED';

-- Reportes por operador y por trámite.
CREATE INDEX idx_turnos_atendido_por
    ON turnos (atendido_por)
    WHERE atendido_por IS NOT NULL;

CREATE INDEX idx_turnos_tramite_periodo
    ON turnos (tramite_id, periodo_operativo_id);

-- No se crea índice sobre token_publico: UNIQUE ya lo garantiza (a diferencia
-- de TOMA_TURNO, que lo declaraba dos veces).

-- ---------------------------------------------------------------------------
-- HISTORIAL / AUDITORÍA
-- ---------------------------------------------------------------------------

-- AMBIGÜEDAD RESUELTA respecto a TOMA_TURNO: allí los ENUM de estado vivían
-- duplicados en turnos y en historial_turnos y se desincronizaban al cambiar
-- un estado. Aquí ambos apuntan al MISMO tipo enum_estado_turno, así que una
-- transición nueva es imposible de escribir de forma inconsistente.
CREATE INDEX idx_historial_turno_fecha
    ON historial_turnos (turno_id, fecha);

CREATE INDEX idx_historial_fecha
    ON historial_turnos (fecha);

CREATE INDEX idx_historial_usuario
    ON historial_turnos (usuario_id)
    WHERE usuario_id IS NOT NULL;

CREATE INDEX idx_auditoria_fecha
    ON auditoria (fecha);

CREATE INDEX idx_auditoria_usuario
    ON auditoria (usuario_id)
    WHERE usuario_id IS NOT NULL;

-- Búsqueda "qué pasó con esta entidad" en la consola de auditoría.
CREATE INDEX idx_auditoria_entidad
    ON auditoria (entidad, entidad_id);

CREATE INDEX idx_auditoria_accion
    ON auditoria (accion);

-- ---------------------------------------------------------------------------
-- FOLIOS / CONFIGURACION
-- ---------------------------------------------------------------------------

-- uq_folios_periodo_tramite (de 001) ya cubre la lectura del contador.
-- uq_configuracion_clave (de 001) cubre la lectura de parámetros.

-- Las FOREIGN KEY de folios, historial, auditoría y turnos ya generan sus
-- propios índices en PostgreSQL; declararlos de nuevo sería redundante.

-- ---------------------------------------------------------------------------
-- SUSCRIPCIONES_PUSH                <<< NUEVO EN DRS v1.5 — RF-028 >>>
-- ---------------------------------------------------------------------------

-- uq_suscripciones_push_token (de 001) cubre las dos consultas que más
-- importan: "¿este turno ya está suscrito?" y "¿a quién avisar de este
-- turno?". La FK hacia turnos añade además el suyo propio.

-- endpoint NO es UNIQUE —un mismo navegador puede tener dos turnos—, así que
-- sí hace falta un índice para localizar una suscripción cuando el servicio
-- push devuelve 410 Gone y hay que darla de baja.
CREATE INDEX idx_suscripciones_push_endpoint
    ON suscripciones_push (endpoint);

-- Barrido de mantenimiento: cuáles de las que siguen activas llevan más
-- rato sin actividad (posible suscripción muerta).
CREATE INDEX idx_suscripciones_push_activa
    ON suscripciones_push (creada_en)
    WHERE activa;
