/**
 * SITUR — Tipos del dominio.
 *
 * Reflejan 1:1 el modelo de datos de `migracion/001_initial_schema.sql` y los
 * ENUM de la base. Si cambia el DDL, cambia este archivo; no se inventan
 * estados aquí (RN-011: la máquina de estados es la de la base).
 */

// ---------------------------------------------------------------------------
// ENUM (migracion/001_initial_schema.sql)
// ---------------------------------------------------------------------------

export type EstadoTurno =
  | 'WAITING'
  | 'CALLED'
  | 'SERVING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'SKIPPED'

export type PrioridadTurno = 'NORMAL' | 'PREFERENTE' | 'URGENTE'

export type EstadoModulo = 'ACTIVO' | 'PAUSADO' | 'FUERA_DE_SERVICIO'

export type EstadoPeriodo = 'ABIERTO' | 'CERRADO'

export type ResultadoAuditoria = 'EXITO' | 'ERROR' | 'DENEGADO'

// ---------------------------------------------------------------------------
// Tablas (solo las columnas que la aplicación usa)
// ---------------------------------------------------------------------------

export interface Tramite {
  id: string
  clave: string
  prefijo: string
  denominacion: string
  activo: boolean
  prioridad: number
  tiempo_estimado_minutos: number | null
}

export interface Modulo {
  id: string
  codigo: string
  denominacion: string
  estado: EstadoModulo
  activo: boolean
}

export interface Rol {
  id: number
  clave: string
  nombre: string
  descripcion: string | null
  activo: boolean
}

export interface Usuario {
  id: string
  nombres: string
  apellido_paterno: string
  apellido_materno: string | null
  email: string
  numero_empleado: string
  rol_clave: string
  modulo_codigo: string | null
  activo: boolean
  mfa_habilitado: boolean
}

export interface PeriodoOperativo {
  id: string
  clave: string
  estado: EstadoPeriodo
  hora_inicio: string | null
  hora_fin: string | null
}

export interface Configuracion {
  id: number
  clave: string
  nombre: string
  valor: string
  tipo: 'TEXTO' | 'ENTERO' | 'DECIMAL' | 'BOOLEANO' | 'JSON'
  descripcion: string | null
  activo: boolean
}

// ---------------------------------------------------------------------------
// Vistas (migracion/003_views.sql)
// ---------------------------------------------------------------------------

/** `vista_cola_espera` — la cola con la posición por trámite+periodo (RN-014). */
export interface FilaCola {
  turno_id: string
  codigo_turno: string
  folio: number
  periodo_operativo_id: string
  tramite_id: string
  clave_tramite: string
  denominacion_tramite: string
  prioridad: PrioridadTurno
  /** Posición dentro de su trámite: es lo que ve el ciudadano (RN-014). */
  posicion: number
  personas_delante: number
  /** Orden real de llamada, entre todos los trámites (RN-017). */
  posicion_global: number
  creado_en: string
  tiempo_estimado_mostrado_minutos: number | null
  tiempo_estimado_minutos: number | null
}

/** `vista_turnos_actuales` — los que están en CALLED o SERVING. */
/**
 * Una llamada de la pantalla pública (RF-020).
 *
 * Son los cuatro campos —y solo cuatro— que devuelve la RPC
 * `ultimas_llamadas`: código del turno, módulo, trámite y hora. No hay token,
 * no hay folio, no hay motivo, no hay nombre.
 */
export interface UltimaLlamada {
  codigo_turno: string
  codigo_modulo: string | null
  denominacion_tramite: string
  llamado_en: string
}

/**
 * Un turno que el titular retiró oponiéndose al tratamiento (RF-033).
 *
 * No es un turno en espera: está cancelado y no se puede llamar. Está aquí
 * para que el operador vea que el ciudadano se retiró, en vez de que el
 * turno desaparezca de la pantalla sin explicación.
 */
export interface FilaRetirado {
  turno_id: string
  codigo_turno: string
  folio: number
  prioridad: PrioridadTurno
  clave_tramite: string
  denominacion_tramite: string
  codigo_modulo: string | null
  denominacion_modulo: string | null
  consideracion: string
  retirado_en: string
}

export interface FilaActual {
  turno_id: string
  codigo_turno: string
  folio: number
  estado: EstadoTurno
  prioridad: PrioridadTurno
  creado_en: string
  llamado_en: string | null
  inicio_atencion: string | null
  numero_llamadas: number
  periodo_operativo_id: string
  tramite_id: string
  clave_tramite: string
  denominacion_tramite: string
  modulo_id: string | null
  codigo_modulo: string | null
  denominacion_modulo: string | null
  trabajador_id: string | null
  nombre_trabajador: string | null
  numero_empleado: string | null
}

/** `vista_historial_turnos` */
export interface FilaHistorial {
  turno_id: string
  codigo_turno: string
  estado_anterior: EstadoTurno | null
  estado_nuevo: EstadoTurno
  /** Estado actual del turno, no el de esta transición. */
  estado_actual: EstadoTurno
  fecha: string
  motivo: string | null
  metadata: unknown
  usuario_id: string | null
  nombre_usuario: string | null
  numero_empleado: string | null
  clave_rol: string | null
  nombre_rol: string | null
  codigo_modulo: string | null
  denominacion_modulo: string | null
}
/** `vista_estadisticas_tramites` */
export interface FilaEstadistica {
  clave_tramite: string
  denominacion_tramite: string
  generados: number
  atendidos: number
  cancelados: number
  omitidos: number
  tiempo_promedio_atencion: number | null
}

// ---------------------------------------------------------------------------
// Respuestas de las RPC (migracion/004_functions_rpc.sql)
// ---------------------------------------------------------------------------

/** Forma común de toda RPC que puede denegar. */
export interface RespuestaDenegada {
  ok: false
  resultado: 'DENEGADO'
  error: string
}

export type Resultado<T> = T | RespuestaDenegada

/** `generar_turno(tramite_id, prioridad?)` */
export interface RespuestaGenerarTurno {
  ok: true
  turno_id: string
  codigo_turno: string
  folio: number
  clave_tramite: string
  denominacion_tramite: string
  estado: EstadoTurno
  prioridad: PrioridadTurno
  periodo: string
  creado_en: string
  token_publico: string
  token_expira_en: string
  tiempo_estimado_minutos: number | null
}

/** `llamar_siguiente_turno(modulo_id?, tramite_id?)` */
export interface RespuestaLlamarSiguiente {
  ok: true
  turno_id: string
  codigo_turno: string
  folio: number
  clave_tramite: string
  denominacion_tramite: string
  codigo_modulo: string
  denominacion_modulo: string
  estado: EstadoTurno
  prioridad: PrioridadTurno
  llamado_en: string
  numero_llamadas: number
  operador: string
}

export interface RespuestaOperacionTurno {
  ok: true
  turno_id: string
  codigo_turno: string
  estado: EstadoTurno
  motivo?: string
  categoria?: string
  numero_llamadas?: number
  llamado_en?: string
  inicio_atencion?: string
  finalizado_en?: string
}

/**
 * `get_turno_publico(token)` — la única puerta del ciudadano (RF-019).
 * Devuelve lo mínimo; el token nunca sale de aquí.
 */
export interface TurnoPublico {
  ok: true
  codigo_turno: string
  folio: number
  estado: EstadoTurno
  prioridad: PrioridadTurno
  denominacion_tramite: string
  posicion: number
  personas_delante: number
  modulo: string | null
  mensaje: string
  creado_en: string
  llamado_en: string | null
  tiempo_estimado_minutos: number | null
  token_expira_en: string | null
}

/** `abrir_periodo_operativo(fecha)` / `cerrar_periodo_operativo(periodo_id)` */
export interface RespuestaPeriodo {
  ok: true
  periodo_id: string
  clave: string
  estado: EstadoPeriodo
  hora_inicio?: string
  hora_fin?: string
  turnos_omitidos_por_cierre?: number
}

/**
 * `proponer_siguiente_turno()` — la propuesta que el operador aprueba antes
 * de llamar. No cambia nada: es una lectura, con la razón.
 */
export interface PropuestaSiguiente {
  ok: true
  hay_turnos: boolean
  mensaje?: string
  turno_id?: string
  codigo_turno?: string
  folio?: number
  clave_tramite?: string
  denominacion_tramite?: string
  prioridad?: PrioridadTurno
  posicion_global?: number
  en_espera?: number
  minutos_esperando?: number
  /** Por qué el sistema va a llamar a este y no a otro. */
  razon?: string
}

/** `reponer_turno(turno_id)` — el carril de recurso del turno omitido. */
export interface RespuestaReposicion {
  ok: true
  turno_id: string
  codigo_turno: string
  folio: number
  token_publico: string
  turno_origen: string
  codigo_origen: string
  clave_tramite: string
  denominacion_tramite: string
  prioridad: PrioridadTurno
  mensaje: string
}

export interface RespuestaSuscripcion {
  ok: true
  codigo_turno?: string
  estado?: EstadoTurno
  eliminadas?: number
  mensaje: string
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export function esDenegada<T>(r: Resultado<T>): r is RespuestaDenegada {
  return (r as { ok?: boolean })?.ok === false
}

/** Etiqueta en español para los estados (la UI nunca muestra el enum crudo). */
export const ETIQUETA_ESTADO: Record<EstadoTurno, string> = {
  WAITING: 'En espera',
  CALLED: 'Llamado',
  SERVING: 'En atención',
  COMPLETED: 'Atendido',
  CANCELLED: 'Cancelado',
  SKIPPED: 'Omitido',
}

export const ETIQUETA_PRIORIDAD: Record<PrioridadTurno, string> = {
  NORMAL: 'Normal',
  PREFERENTE: 'Preferente',
  URGENTE: 'Urgente',
}

export const ETIQUETA_ESTADO_MODULO: Record<EstadoModulo, string> = {
  ACTIVO: 'Activo',
  PAUSADO: 'Pausado',
  FUERA_DE_SERVICIO: 'Fuera de servicio',
}

/** Códigos HTTP/Postgres que usa la base para señalar un token inválido. */
export const CODIGO_TOKEN_INVALIDO = 'P0002'
export const CODIGO_TOKEN_EXPIRADO = 'P0001'
