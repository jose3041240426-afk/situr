import { supabase } from './supabase'
import type {
  EstadoTurno,
  FilaCola,
  FilaActual,
  CifrasPeriodo,
  FilaRetirado,
  FilaHistorial,
  FilaEstadistica,
  Modulo,
  PeriodoOperativo,
  PrioridadTurno,
  PropuestaSiguiente,
  LoteTurnos,
  RespuestaGenerarTurno,
  RespuestaGenerarTurnosMasivos,
  RespuestaProgramarAviso,
  RespuestaAvisoTurno,
  RespuestaLlamarSiguiente,
  RespuestaOperacionTurno,
  RespuestaPeriodo,
  RespuestaReposicion,
  RespuestaSuscripcion,
  Resultado,
  Tramite,
  TurnoPublico,
  Usuario,
  UltimaLlamada,
  RespuestaEstadoVentanillas,
  RespuestaSolicitarTurnoVentanilla,
} from './tipos'

/**
 * SITUR — Capa de acceso a datos.
 *
 * Todas las operaciones de escritura pasan por RPC del servidor. El cliente
 * **nunca** escribe en una tabla base: la base decide (RN-007 «solo
 * autorizados modifican», RN-011 «respetar la máquina de estados»).
 *
 * La lectura administrativa usa las 5 vistas de `migracion/003_views.sql`.
 */

export class ErrorSitur extends Error {
  constructor(
    message: string,
    readonly codigo?: string,
  ) {
    super(message)
    this.name = 'ErrorSitur'
  }
}

/** Traduce el error de Postgres a un mensaje que la UI pueda mostrar. */
function traducirError(error: { message: string; code?: string }): ErrorSitur {
  const crudo = error.message.replace(/^.*?:\s*/, '').trim()

  // Los mensajes de la base están escritos para quien la conoce. El operador
  // de ventanilla no tiene por que traducir "Sesion invalida" ni "Transicion
  // WAITING -> CALLED no permitida" (Nielsen H9: el error debe decir que
  // paso y que hacer, no hablar en el idioma del servidor).
  const traducidos: [RegExp, string][] = [
    [/Sesion invalida/i, 'Su sesión ya no es válida. Vuelva a entrar.'],
    [
      /No hay periodo operativo abierto/i,
      'No hay periodo abierto hoy. Abrialo antes de emitir turnos.',
    ],
    [/No existen turnos pendientes/i, 'No queda ningun turno en espera para este periodo.'],
    [
      /Transicion .* no permitida/i,
      'Ese turno ya no esta en espera: es posible que otro modulo lo haya llamado.',
    ],
    [
      /ya no esta en espera/i,
      'Ese turno ya no esta en espera: es posible que otro modulo lo haya llamado.',
    ],
    [/No hay modulos activos/i, 'No hay ningun modulo activo. Active uno en Catalogos.'],
    [/El tramite no existe o esta inactivo/i, 'Ese tramite no esta disponible.'],
    [/Se alcanzo el maximo de turnos/i, 'Ese tramite llego al maximo de turnos del dia.'],
    [/Token invalido o inexistente/i, 'Este codigo no existe. Escanee el QR de nuevo.'],
    [/Token expirado/i, 'Este codigo ya vencio. Escanee el QR de nuevo.'],
    [
      /El periodo del turno ya no esta abierto/i,
      'Ya no se puede reponer: el periodo se cerro.',
    ],
  ]

  for (const [patron, texto] of traducidos) {
    if (patron.test(crudo)) return new ErrorSitur(texto, error.code)
  }

  return new ErrorSitur(crudo || 'Ocurrio un error inesperado.', error.code)
}

async function rpc<T>(
  nombre: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.rpc(nombre, args)
  if (error) throw traducirError(error)
  return data as T
}

// ===========================================================================
// TURNO DEL CIUDADANO  (RF-017, RF-018, RF-019)
// ===========================================================================

/**
 * Consulta pública. Es la **única** vía del ciudadano al turno: no lee
 * `turnos` (su rol `anon` no tiene privilegio sobre esa tabla).
 *
 * Va contra `/api/turno` y no directamente contra Supabase, y hay una razón
 * concreta: el DRS §10 pide limitar por IP + token la consulta pública, y
 * una llamada directa a `supabase.co` **nunca pasa por el Edge Middleware**.
 * Con esta ruta, el límite existe de verdad.
 */
export async function consultarTurnoPublico(token: string): Promise<TurnoPublico> {
  const respuesta = await fetch(`/api/turno?token=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
  })

  if (!respuesta.ok) {
    const cuerpo = (await respuesta.json().catch(() => ({}))) as { error?: string }
    // El mensaje de la base se traduce con la misma tabla que el resto: el
    // ciudadano no ve "Token invalido" de Postgres.
    throw traducirError({
      message: cuerpo.error ?? 'No se pudo consultar su turno.',
      code: String(respuesta.status),
    })
  }

  return (await respuesta.json()) as TurnoPublico
}

// ===========================================================================
// GESTIÓN DE TURNOS  (RF-005 a RF-016)
// ===========================================================================

/** Emite un turno. El folio consecutivo lo asigna la base (RN-003). */
export async function generarTurno(
  tramiteId: string,
  prioridad?: PrioridadTurno,
): Promise<RespuestaGenerarTurno> {
  return rpc<RespuestaGenerarTurno>('generar_turno', {
    p_tramite_id: tramiteId,
    p_prioridad: prioridad ?? null,
  })
}

/**
 * Emite un lote de turnos en una sola transacción (migración 009).
 *
 * Ejemplo: 25 del trámite A y 25 del trámite B en una sola llamada. Es
 * atómica: si un trámite del lote no es válido, no se emite ninguno.
 */
export async function generarTurnosMasivos(
  lotes: LoteTurnos[],
): Promise<RespuestaGenerarTurnosMasivos> {
  return rpc<RespuestaGenerarTurnosMasivos>('generar_turnos_masivos', {
    p_lotes: lotes,
  })
}

/**
 * Programa el aviso push de los próximos turnos de la cola (migración 014).
 *
 * Se avisa a tantos turnos como lugares de atención ocupados haya ahora
 * (CALLED + SERVING), con un mínimo de uno: con tres turnos abiertos se
 * avisa a los tres siguientes. Los minutos permitidos los decide la
 * dependencia en `configuracion`; la consola los pide con `opcionesAviso()`
 * para no ofrecer un valor que la base vaya a rechazar.
 */
export async function programarAvisoSiguiente(
  minutos: number,
  tramiteId?: string | null,
): Promise<RespuestaProgramarAviso> {
  return rpc<RespuestaProgramarAviso>('programar_aviso_siguiente', {
    p_minutos: minutos,
    p_tramite_id: tramiteId ?? null,
  })
}

/** Deshace un aviso programado que todavía no ha salido. */
export async function cancelarAvisoSiguiente(turnoId: string): Promise<boolean> {
  return rpc<boolean>('cancelar_aviso_siguiente', { p_turno_id: turnoId })
}

/** Los minutos que la consola puede ofrecer (5, 10, 15 por defecto). */
export async function opcionesAviso(): Promise<number[]> {
  return rpc<number[]>('opciones_aviso_minutos', {})
}

/**
 * Avisa a un turno concreto que ya está en atención (CALLED/SERVING).
 *
 * El operador elige los minutos y el cron manda el push a ese ciudadano. A
 * diferencia de `programarAvisoSiguiente` (que avisa a los siguientes de la
 * cola), aquí el aviso va a quien ya está siendo atendido o llamado, con la
 * hora que elija el operador.
 */
export async function programarAvisoTurno(
  turnoId: string,
  minutos: number,
): Promise<RespuestaAvisoTurno> {
  return rpc<RespuestaAvisoTurno>('programar_aviso_turno', {
    p_turno_id: turnoId,
    p_minutos: minutos,
  })
}

/**
 * Llama al siguiente turno elegible (RN-009).
 *
 * `moduloId` y `tramiteId` son opcionales a propósito: la RPC resuelve el
 * módulo por RG-004 (el del operador si está ACTIVO) y el trámite acota la
 * cola. Es la opción C del punto 10 de PREGUNTAS_para_el_asesor.txt — la
 * reversible: con `tramiteId = null` la cola es global (RN-017).
 */
export async function llamarSiguiente(
  moduloId?: string | null,
  tramiteId?: string | null,
): Promise<RespuestaLlamarSiguiente> {
  return rpc<RespuestaLlamarSiguiente>('llamar_siguiente_turno', {
    p_modulo_id: moduloId ?? null,
    p_tramite_id: tramiteId ?? null,
  })
}

export async function repetirLlamada(turnoId: string): Promise<RespuestaOperacionTurno> {
  return rpc<RespuestaOperacionTurno>('repetir_llamada', { p_turno_id: turnoId })
}

/**
 * La propuesta que el operador aprueba **antes** de llamar (P5).
 *
 * Usa el mismo filtro y el mismo orden que `llamar_siguiente_turno()`, así
 * que no puede mentir: dice a quién va a llamar y por qué. No cambia nada.
 */
export async function proponerSiguienteTurno(
  moduloId?: string | null,
  tramiteId?: string | null,
): Promise<PropuestaSiguiente> {
  return rpc<PropuestaSiguiente>('proponer_siguiente_turno', {
    p_modulo_id: moduloId ?? null,
    p_tramite_id: tramiteId ?? null,
  })
}

/**
 * Llama a un turno **concreto** de la cola (P10: redirigir).
 *
 * Es lo que evita tener que omitir al que no toca: omitir quema el turno de
 * ese ciudadano. Aquí los demás siguen intactos.
 */
export async function llamarTurno(turnoId: string): Promise<RespuestaLlamarSiguiente> {
  return rpc<RespuestaLlamarSiguiente>('llamar_turno', { p_turno_id: turnoId })
}

/**
 * Emite un turno nuevo para un turno omitido o cancelado (P12: el carril de
 * recurso). Devuelve el token del turno nuevo, para poder reimprimir el QR.
 */
export async function reponerTurno(turnoId: string): Promise<RespuestaReposicion> {
  return rpc<RespuestaReposicion>('reponer_turno', { p_turno_id: turnoId })
}

export async function iniciarAtencion(turnoId: string): Promise<RespuestaOperacionTurno> {
  return rpc<RespuestaOperacionTurno>('iniciar_atencion_turno', { p_turno_id: turnoId })
}

export async function finalizarTurno(turnoId: string): Promise<RespuestaOperacionTurno> {
  return rpc<RespuestaOperacionTurno>('finalizar_turno', { p_turno_id: turnoId })
}

export async function cancelarTurno(
  turnoId: string,
  motivo: string,
): Promise<RespuestaOperacionTurno> {
  return rpc<RespuestaOperacionTurno>('cancelar_turno', {
    p_turno_id: turnoId,
    p_motivo: motivo,
  })
}

/**
 * RF-026: apunta en la ficha del operador que ya tiene el segundo factor.
 *
 * Inscribir el TOTP es cosa de Supabase Auth; el permiso para operar lo
 * decide `usuarios.mfa_habilitado`. Sin esta llamada, el operador veía «MFA
 * configurado» y la consola le seguía pidiendo configurarlo.
 */
export async function marcarMfaHabilitado(): Promise<{ ok: true; mfa_habilitado: boolean }> {
  return rpc('marcar_mfa_habilitado', {})
}

export async function omitirTurno(
  turnoId: string,
  motivo: string,
  categoria = 'OMISION_MANUAL',
): Promise<RespuestaOperacionTurno> {
  return rpc<RespuestaOperacionTurno>('omitir_turno', {
    p_turno_id: turnoId,
    p_motivo: motivo,
    p_categoria: categoria,
  })
}

/**
 * Marca que el papel impreso de un turno ya se entregó a una persona.
 *
 * No cambia el estado ni el orden de llamada: es una marca de recepción. La
 * casilla de la cola de espera la pone una sola vez y no se deshace, así que
 * llamar dos veces no es un error (la RPC es idempotente).
 */
export async function marcarTurnoReclamado(turnoId: string): Promise<{
  ok: true
  turno_id: string
  codigo_turno: string
  reclamado_en: string | null
  ya_reclamado: boolean
  estado: EstadoTurno
}> {
  return rpc('marcar_turno_reclamado', { p_turno_id: turnoId })
}

// ===========================================================================
// PERIODO OPERATIVO  (RF-025, RG-002)
// ===========================================================================

export async function abrirPeriodo(fecha: string): Promise<RespuestaPeriodo> {
  return rpc<RespuestaPeriodo>('abrir_periodo_operativo', { p_fecha: fecha })
}

export async function cerrarPeriodo(periodoId: string): Promise<RespuestaPeriodo> {
  return rpc<RespuestaPeriodo>('cerrar_periodo_operativo', { p_periodo_id: periodoId })
}

// ===========================================================================
// NOTIFICACIONES PUSH  (RF-028, DRS §5.2)
// ===========================================================================

/**
 * Da de alta la suscripción. `SECURITY DEFINER` y ejecutable por `anon`:
 * lo que autoriza es **conocer el token**, no haber iniciado sesión.
 */
export async function registrarSuscripcion(
  token: string,
  endpoint: string,
  claveP256dh: string,
  claveAuth: string,
): Promise<RespuestaSuscripcion> {
  return rpc<RespuestaSuscripcion>('registrar_suscripcion_push', {
    p_token: token,
    p_endpoint: endpoint,
    p_clave_p256dh: claveP256dh,
    p_clave_auth: claveAuth,
  })
}

export async function eliminarSuscripcion(token: string): Promise<RespuestaSuscripcion> {
  return rpc<RespuestaSuscripcion>('eliminar_suscripcion_push', { p_token: token })
}

// ===========================================================================
// LECTURA ADMINISTRATIVA  (vistas)
// ===========================================================================

/**
 * La cola de espera, en el orden real en que se va a llamar.
 *
 * `vista_cola_espera` trae su propio `ORDER BY` (migración 035), así que el
 * orden llega puesto desde la base: es el mismo que usa
 * `llamar_siguiente_turno()` (RN-017). Antes la vista no lo traía y el
 * orden dependía del plan de ejecución —el índice `idx_turnos_cola` agrupa
 * por `tramite_id`—, de modo que «G-0001» salía antes que «A-0002» aunque
 * el A-0002 se hubiera emitido antes.
 *
 * Se ordena igual en el cliente por `posicion_global` para que la fila que
 * se ve primero sea la que se va a llamar, y `creado_en` queda como
 * desempate defensivo.
 */
export async function listarCola(): Promise<FilaCola[]> {
  const { data, error } = await supabase.from('vista_cola_espera').select('*')
  if (error) throw traducirError(error)
  return ((data ?? []) as FilaCola[]).sort(
    (a, b) =>
      a.posicion_global - b.posicion_global ||
      a.creado_en.localeCompare(b.creado_en) ||
      a.codigo_turno.localeCompare(b.codigo_turno),
  )
}

/**
 * La cola de la pantalla de turnos en vivo, POR FECHA DE CREACIÓN.
 *
 * Es una RPC de la base (`cola_en_vivo`) y no una consulta suelta, por dos
 * razones:
 *
 *   - El orden por llegada lo calcula la base (`posicion_llegada`). El folio
 *     NO sirve para ordenar: es un contador por trámite, así que «G-0001» y
 *     «A-002» no son comparables. La hora de creación sí lo es.
 *   - `turnos` solo es legible por ADMINISTRADOR y RECEPCIÓN (RLS), y esta
 *     pantalla la abre cualquier operador.
 *
 * Trae las dos posiciones a propósito: `posicion_llegada` es la que se
 * muestra al ciudadano (cuántas personas hay delante) y `posicion_global` es
 * el orden real de llamada, que puede adelantar a alguien con prioridad.
 */
export type FilaColaVivo = {
  turno_id: string
  codigo_turno: string
  folio: number
  clave_tramite: string
  denominacion_tramite: string
  prioridad: PrioridadTurno
  /** Posición por fecha de creación: la que ve el ciudadano. */
  posicion_llegada: number
  /** Posición real de llamada (RN-017): puede ser anterior si hay prioridad. */
  posicion_global: number
  creado_en: string
}

export type ColaEnVivo = {
  total: number
  filas: FilaColaVivo[]
}

export async function colaEnVivo(limite = 10): Promise<ColaEnVivo> {
  const { data, error } = await supabase.rpc('cola_en_vivo', { p_limite: limite })
  if (error) throw traducirError(error)
  const r = (data ?? {}) as { total?: number; filas?: FilaColaVivo[] }
  return { total: r.total ?? 0, filas: r.filas ?? [] }
}

/**
 * El último turno emitido del periodo, con su token: el que la pantalla de
 * turnos en vivo ofrece para escanear.
 *
 * Es la RPC `ultimo_turno_emitido()`. Va por RPC y no por consulta directa
 * a `turnos` porque el token es lo que abre el portal del ciudadano y la
 * tabla `turnos` está restringida por RLS a ADMINISTRADOR y RECEPCIÓN.
 */
export type UltimoTurnoEmitido = {
  hay_turno: boolean
  turno_id: string
  codigo_turno: string
  folio: number
  estado: string
  prioridad: PrioridadTurno
  token_publico: string
  clave_tramite: string
  denominacion_tramite: string
  creado_en: string
}

export async function ultimoTurnoEmitido(): Promise<UltimoTurnoEmitido | null> {
  const { data, error } = await supabase.rpc('ultimo_turno_emitido')
  if (error) throw traducirError(error)
  const r = (data ?? {}) as Partial<UltimoTurnoEmitido>
  if (!r.hay_turno) return null
  return {
    hay_turno: true,
    turno_id: r.turno_id ?? '',
    codigo_turno: r.codigo_turno ?? '',
    folio: r.folio ?? 0,
    estado: r.estado ?? '',
    prioridad: (r.prioridad ?? 'NORMAL') as PrioridadTurno,
    token_publico: r.token_publico ?? '',
    clave_tramite: r.clave_tramite ?? '',
    denominacion_tramite: r.denominacion_tramite ?? '',
    creado_en: r.creado_en ?? '',
  }
}

/**
 * El token público de un turno concreto, para pintar SU código QR.
 *
 * Va por la RPC `token_turno_para_qr()` y no por una lectura directa a
 * `turnos` porque esa tabla solo es legible por ADMINISTRADOR y RECEPCIÓN
 * (RLS): un AGENTE recibiría cero filas y el QR nunca se pintaría. La RPC
 * comprueba además que quien llama puede operar turnos, y renueva el token
 * si ya había caducado, para que el QR que se muestra sirva de verdad.
 */
export type TokenTurnoQr = {
  turno_id: string
  codigo_turno: string
  folio: number
  estado: string
  prioridad: PrioridadTurno
  token_publico: string
}

export async function tokenTurnoParaQr(turnoId: string): Promise<TokenTurnoQr> {
  const { data, error } = await supabase.rpc('token_turno_para_qr', { p_turno_id: turnoId })
  if (error) throw traducirError(error)
  const r = (data ?? {}) as Partial<TokenTurnoQr>
  return {
    turno_id: r.turno_id ?? turnoId,
    codigo_turno: r.codigo_turno ?? '',
    folio: r.folio ?? 0,
    estado: r.estado ?? '',
    prioridad: (r.prioridad ?? 'NORMAL') as PrioridadTurno,
    token_publico: r.token_publico ?? '',
  }
}

/**
 * El token público de un turno, para pintar su código QR desde la cola.
 *
 * El QR no se genera al emitir un lote: de un lote salen cientos de folios y
 * el ciudadano no está delante para escanear ninguno. Aquí el operador ya
 * tiene a la persona en la ventanilla, así que el QR se pide para ESE turno y
 * se imprime o se dicta en ese momento.
 *
 * El token no revela nada del ciudadano: es un número aleatorio que solo
 * sirve para abrir `/turno/{token}` (RF-017).
 */
/**
 * Resultado de consultar un papel en recepción.
 *
 * Se busca por `codigo` y no por `folio` porque el folio NO es único: cada
 * trámite lleva su propio contador (`uq_turnos_periodo_tramite_folio`), así que
 * «folio 1» existe tres veces el mismo día.
 */
export type ConsultaTurno = {
  turno_id: string
  codigo_turno: string
  folio: number
  estado: string
  tiene_dueno: boolean
  nombre_trabajador: string | null
  codigo_modulo: string | null
  clave_tramite: string
  denominacion_tramite: string
  creado_en: string
  llamado_en: string | null
}

/**
 * ¿Este papel todavía vale o alguien ya lo tomó?
 *
 * Devuelve `null` cuando el código no existe, para que la interfaz pueda decir
 * «no encontrado» sin tratarlo como error.
 */
export async function consultarTurnoPorCodigo(codigo: string): Promise<ConsultaTurno | null> {
  const limpio = codigo.trim()
  if (!limpio) return null

  const { data, error } = await supabase.rpc('consultar_turno_por_codigo', { p_codigo: limpio })
  if (error) throw traducirError(error)

  /* La función es `RETURNS TABLE`, así que PostgREST devuelve un arreglo con
     cero o una fila, nunca un objeto suelto. */
  const filas = (data ?? []) as ConsultaTurno[]
  return filas[0] ?? null
}

export async function tokenDeTurno(turnoId: string): Promise<string> {
  const { data, error } = await supabase
    .from('turnos')
    .select('token_publico')
    .eq('id', turnoId)
    .single()
  if (error) throw traducirError(error)
  return (data as { token_publico: string }).token_publico
}

/**
 * Los turnos en curso, para la consola del operador.
 *
 * El operador tiene sesión, así que la RLS le deja leer la vista. Esta
 * función NO se usa desde la pantalla pública: allí no hay sesión, y la
 * RLS lo negaría (ver `listarUltimasLlamadas`).
 */
/**
 * Las cifras del periodo en curso (RF-022): generados, atendidos, cancelados,
 * omitidos y en espera.
 *
 * Se suman las filas por tramite de `vista_estadisticas_tramites`: la vista
 * trae una fila por tramite, y la tarjeta de la consola wants el total del
 * dia.
 */
export async function listarCifrasDelPeriodo(): Promise<CifrasPeriodo> {
  const { data, error } = await supabase.from('vista_estadisticas_tramites').select('*')
  if (error) throw traducirError(error)
  const filas = (data ?? []) as {
    turnos_generados: number
    turnos_atendidos: number
    turnos_cancelados: number
    turnos_omitidos: number
    turnos_sin_atender: number
  }[]
  const sumar = (k: keyof (typeof filas)[number]) =>
    filas.reduce((total, f) => total + Number(f[k] ?? 0), 0)
  return {
    generados: sumar('turnos_generados'),
    atendidos: sumar('turnos_atendidos'),
    cancelados: sumar('turnos_cancelados'),
    omitidos: sumar('turnos_omitidos'),
    en_espera: sumar('turnos_sin_atender'),
  }
}

/**
 * Los turnos que el titular retiró oponiéndose al tratamiento (RF-033).
 *
 * No están en la cola de espera: están cancelados. Van aparte para que el
 * operador vea que el ciudadano se retiró, en vez de que el turno
 * desaparezca de la pantalla sin dejar rastro.
 */
export async function listarTurnosRetirados(): Promise<FilaRetirado[]> {
  const { data, error } = await supabase.from('vista_turnos_retirados').select('*')
  if (error) throw traducirError(error)
  return (data ?? []) as FilaRetirado[]
}

export async function listarTurnosActuales(): Promise<FilaActual[]> {
  const { data, error } = await supabase.from('vista_turnos_actuales').select('*')
  if (error) throw traducirError(error)
  return (data ?? []) as FilaActual[]
}

/**
 * Las últimas llamadas, para la pantalla pública (RF-020).
 *
 * Pasa por `/api/ultimas-llamadas` y no directamente a Supabase, por dos
 * razones a la vez:
 *
 *   * La RPC `ultimas_llamadas` es la que devuelve los cuatro campos
 *     públicos. La RLS no da acceso a `anon` a `vista_turnos_actuales`, y
 *     con la `service_role` se vería toda la tabla de turnos.
 *   * Al pasar por el servidor, la petición atraviesa el Edge Middleware y
 *     el límite de tasa del DRS §10 existe de verdad.
 */
export async function listarUltimasLlamadas(limite = 8): Promise<UltimaLlamada[]> {
  const respuesta = await fetch(`/api/ultimas-llamadas?limite=${limite}`, {
    headers: { accept: 'application/json' },
  })
  const cuerpo = (await respuesta.json().catch(() => ({}))) as {
    llamadas?: UltimaLlamada[]
  }
  if (!respuesta.ok) return []
  return cuerpo.llamadas ?? []
}

export async function listarHistorial(turnoId?: string): Promise<FilaHistorial[]> {
  let q = supabase.from('vista_historial_turnos').select('*')
  if (turnoId) q = q.eq('turno_id', turnoId)
  const { data, error } = await q.order('fecha', { ascending: false })
  if (error) throw traducirError(error)
  return (data ?? []) as FilaHistorial[]
}

export async function listarEstadisticas(): Promise<FilaEstadistica[]> {
  const { data, error } = await supabase.from('vista_estadisticas_tramites').select('*')
  if (error) throw traducirError(error)
  return (data ?? []) as FilaEstadistica[]
}

/**
 * Catálogos. Los lee `authenticated`; la RLS los deja pasar a cualquier
 * sesión iniciada y la escritura queda con la política de administrador.
 */
export async function listarTramites(soloActivos = true): Promise<Tramite[]> {
  let q = supabase.from('tramites').select('*')
  if (soloActivos) q = q.eq('activo', true)
  const { data, error } = await q.order('clave')
  if (error) throw traducirError(error)
  return (data ?? []) as Tramite[]
}

export async function listarModulos(): Promise<Modulo[]> {
  const { data, error } = await supabase.from('modulos').select('*').order('codigo')
  if (error) throw traducirError(error)
  return (data ?? []) as Modulo[]
}

export async function listarPeriodos(): Promise<PeriodoOperativo[]> {
  const { data, error } = await supabase
    .from('periodos_operativos')
    .select('*')
    .order('clave', { ascending: false })
  if (error) throw traducirError(error)
  return (data ?? []) as PeriodoOperativo[]
}

/**
 * El periodo abierto, o `null` si no hay ninguno. Se llama así, y no
 * `periodoAbierto`, para no chocar con la variable de estado de la consola.
 *
 * Dos diferencias con `listarPeriodos()`, y las dos importan:
 *
 *   1. Filtra en la base. `listarPeriodos()` trae TODOS los periodos
 *      históricos y el cliente elegía el abierto con `.find()`. Con años de
 *      operación eso es una lista creciente para usar un solo elemento.
 *
 *   2. Es una consulta propia, no va dentro del `Promise.all` de la consola.
 *      Así el estado del periodo (y su botón) no espera a las otras seis
 *      consultas: aparece en cuanto llega esta.
 *
 * `maybeSingle()` y no `single()`: «no hay periodo abierto» es un estado
 * normal —al empezar el día—, no un error. Con `single()` PostgREST
 * devolvería un 406 y habría que tratar el caso como excepción.
 */
export async function obtenerPeriodoAbierto(): Promise<PeriodoOperativo | null> {
  const { data, error } = await supabase
    .from('periodos_operativos')
    .select('*')
    .eq('estado', 'ABIERTO')
    .maybeSingle()
  if (error) throw traducirError(error)
  return (data as PeriodoOperativo | null) ?? null
}

/**
 * Usuarios. La vista de `usuarios` no existe: se lee la tabla con el join a
 * `apellidos` y `roles`, que es lo que hace la política `p_usuarios_admin`
 * (administradores) y `p_usuarios_propio` (el propio usuario).
 */
export async function listarUsuarios(): Promise<Usuario[]> {
  const { data, error } = await supabase
    .from('usuarios')
    .select(
      'id, nombres, email, numero_empleado, activo, mfa_habilitado, ' +
        'apellido_paterno:apellidos!fk_usuarios_apellido_paterno(apellido), ' +
        'apellido_materno:apellidos!fk_usuarios_apellido_materno(apellido), ' +
        'rol:roles!fk_usuarios_roles(clave), ' +
        'modulo:modulos!fk_usuarios_modulos(codigo)',
    )
    .order('numero_empleado')
  if (error) throw traducirError(error)
  return (data ?? []).map((fila) => {
    const f = fila as unknown as {
      id: string
      nombres: string
      email: string
      numero_empleado: string
      activo: boolean
      mfa_habilitado: boolean
      apellido_paterno: { apellido: string } | null
      apellido_materno: { apellido: string } | null
      rol: { clave: string } | null
      modulo: { codigo: string } | null
    }
    return {
      id: f.id,
      nombres: f.nombres,
      apellido_paterno: f.apellido_paterno?.apellido ?? '',
      apellido_materno: f.apellido_materno?.apellido ?? null,
      email: f.email,
      numero_empleado: f.numero_empleado,
      rol_clave: f.rol?.clave ?? 'ADMINISTRADOR',
      modulo_codigo: f.modulo?.codigo ?? null,
      activo: f.activo,
      mfa_habilitado: f.mfa_habilitado,
    }
  })
}

/** Asigna (o libera) el módulo de un usuario. Solo administradores (RN-007). */
export async function asignarModuloUsuario(
  usuarioId: string,
  moduloId: string | null,
): Promise<Resultado<{ ok: true }>> {
  return rpc<Resultado<{ ok: true }>>('asignar_modulo_usuario', {
    p_usuario_id: usuarioId,
    p_modulo_id: moduloId,
  })
}

// ===========================================================================
// UTILIDADES DE PRESENTACIÓN
// ===========================================================================

/**
 * Formatea una fecha como `dd/mm/aaaa`, que es el orden que se usa en México.
 *
 * `dateStyle: 'medium'` de `es-MX` produce «8 nov 2026», con el mes en medio.
 * Aquí se pide explícitamente día/mes/año en dos dígitos.
 *
 * Acepta tanto una marca ISO completa (`2026-11-08T15:04:05Z`) como la clave
 * de un periodo, que ya viene como `2026-11-08`.
 */
export function formatearFecha(iso: string | null | undefined): string {
  if (!iso) return '—'

  // Una clave `aaaa-mm-dd` se interpreta como fecha local. `new Date('2026-11-08')`
  // la trataría como UTC y en México se vería el día anterior.
  const soloFecha = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (soloFecha) {
    const [, a, m, d] = soloFecha
    return `${d}/${m}/${a}`
  }

  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mazatlan',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d)
}

/** Formatea una marca de tiempo como `dd/mm/aaaa hh:mm` (RG-001). */
export function formatearFechaHora(iso: string | null | undefined): string {
  if (!iso) return '—'

  /*
   * Una clave `aaaa-mm-dd` viene sin hora. Interpretarla con `new Date(iso)`
   * la trata como medianoche UTC, que en Mazatlán (UTC-7) cae el día anterior
   * a las 5 de la tarde. Añadirle `T00:00:00` tampoco sirve: eso usa la zona
   * del RUNTIME (el servidor, no el usuario) y da otro día distinto.
   *
   * La única forma segura es fijar la zona objetivo a mano: se fija el
   * mediodía de Mazatlán, que está lejos de cualquier cambio de día y de
   * cualquier horario de verano.
   */
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso)
  const d = new Date(soloFecha ? `${iso}T12:00:00-07:00` : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mazatlan',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

export function formatearSoloHora(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mazatlan',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** Etiqueta corta de un estado, para las tablas del panel. */
export function etiquetaEstado(estado: EstadoTurno): string {
  switch (estado) {
    case 'WAITING':
      return 'En espera'
    case 'CALLED':
      return 'Llamado'
    case 'SERVING':
      return 'En atención'
    case 'COMPLETED':
      return 'Atendido'
    case 'CANCELLED':
      return 'Cancelado'
    case 'SKIPPED':
      return 'Omitido'
  }
}/**
 * El titular manifiesta su consideracion y se opone al tratamiento
 * (RF-033, LFPDPPP art. 21).
 *
 * Se hace con el token, que es lo unico que el ciudadano tiene: no hace
 * falta cuenta ni sesion. Devuelve el mensaje para el ciudadano.
 */
export async function manifestarConsideraciones(
  token: string,
  consideraciones: string,
): Promise<{ ok: boolean; mensaje: string; codigo_turno?: string }> {
  const respuesta = await fetch('/api/consideraciones', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, consideraciones }),
  })

  const cuerpo = (await respuesta.json().catch(() => ({}))) as {
    ok?: boolean
    mensaje?: string
    error?: string
    codigo_turno?: string
  }

  if (!respuesta.ok) {
    throw new ErrorSitur(
      cuerpo.error ?? 'No se pudo registrar su consideración.',
      String(respuesta.status),
    )
  }

  return { ok: true, mensaje: cuerpo.mensaje ?? '', codigo_turno: cuerpo.codigo_turno }
}



/**
 * Cuántos turnos CALLED+SERVING puede tener abiertos un operador (migración
 * 010).
 *
 * El valor vive en `configuracion` para que la dependencia lo ajuste sin
 * recompilar, igual que MAXIMO_TURNOS_LOTE. La consola lo usa para deshabilitar
 * «Llamar» con un motivo visible en lugar de dejar que el servidor rechace la
 * llamada sin explicación.
 */
export async function maximoEnAtencion(): Promise<number> {
  return rpc<number>('maximo_en_atencion', {})
}

/**
 * El ciudadano elige con cuánta anticipación quiere el aviso.
 * `null` = usar el default del sistema. Solo funciona con el token y solo
 * mientras el turno está en `WAITING`.
 */
export async function actualizarPreferenciaAviso(
  token: string,
  minutos: number | null,
): Promise<{
  ok: boolean
  preferencia_aviso_minutos: number | null
  mensaje: string
}> {
  const { data, error } = await supabase.rpc('actualizar_preferencia_aviso', {
    p_token: token,
    p_minutos: minutos,
  })
  if (error) throw traducirError(error)
  return data as {
    ok: boolean
    preferencia_aviso_minutos: number | null
    mensaje: string
  }
}

/**
 * Historial paginado por turno (migración 019).
 *
 * Reemplaza a `listarHistorial()` para la pantalla del historial: con 1000
 * turnos, traer todas las transiciones colapsaba el navegador. Esta versión
 * filtra por fecha, pagina por turno, y devuelve las transiciones anidadas.
 */
export interface TurnoHistorialPaginado {
  turno_id: string
  codigo_turno: string
  estado_actual: EstadoTurno
  prioridad: PrioridadTurno
  denominacion_tramite: string
  clave_tramite: string
  transiciones: Array<{
    turno_id: string
    codigo_turno: string
    estado_anterior: EstadoTurno | null
    estado_nuevo: EstadoTurno
    estado_actual: EstadoTurno
    fecha: string
    motivo: string | null
    nombre_usuario: string | null
    codigo_modulo: string | null
    denominacion_modulo: string | null
  }>
}

export async function listarHistorialPaginado(
  fecha: string,
  filtro: string | undefined,
  pagina: number,
  porPagina = 10,
): Promise<{ total: number; turnos: TurnoHistorialPaginado[] }> {
  const { data, error } = await supabase.rpc('listar_historial_paginado', {
    p_fecha: fecha,
    p_filtro: filtro?.trim() || null,
    p_limite: porPagina,
    p_offset: (pagina - 1) * porPagina,
  })
  if (error) throw traducirError(error)
  const r = data as { total: number; turnos: TurnoHistorialPaginado[] }
  return { total: r.total ?? 0, turnos: r.turnos ?? [] }
}

/**
 * SITUR — Revalidación de la contraseña.
 *
 * La usa el perfil antes de dejar cambiar el segundo factor: comprobar la
 * contraseña otra vez es lo que separa «el operador está en su cuenta» de
 * «alguien se sentó en un equipo de ventanilla con la sesión abierta».
 *
 * Va contra `/api/verificar-clave`, no contra Supabase desde el navegador:
 * la comprobación se hace en el servidor y no se abre ninguna sesión nueva
 * en el navegador, así que la sesión del operador no se degrada a un solo
 * factor a medio camino.
 *
 * Devuelve `true` si la contraseña es correcta y `false` si no lo es. Un
 * fallo de la ruta (no de la contraseña) se lanza como error.
 */
export async function revalidarClave(correo: string, password: string): Promise<boolean> {
  const r = await fetch('/api/verificar-clave', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: correo, password }),
  })
  if (r.status === 401) return false
  if (!r.ok) {
    throw new Error('No se pudo comprobar la contraseña. Inténtelo de nuevo.')
  }
  return true
}

export async function estadoVentanillas(): Promise<RespuestaEstadoVentanillas> {
  const { data, error } = await supabase.rpc('estado_ventanillas')
  if (error) throw traducirError(error)
  return data as RespuestaEstadoVentanillas
}

export async function solicitarTurnoVentanilla(moduloId: string): Promise<RespuestaSolicitarTurnoVentanilla> {
  const { data, error } = await supabase.rpc('solicitar_turno_ventanilla', { p_modulo_id: moduloId })
  if (error) throw traducirError(error)
  return data as RespuestaSolicitarTurnoVentanilla
}
