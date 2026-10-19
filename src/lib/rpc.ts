import { supabase } from './supabase'
import type {
  EstadoTurno,
  FilaCola,
  FilaActual,
  FilaRetirado,
  FilaHistorial,
  FilaEstadistica,
  Modulo,
  PeriodoOperativo,
  PrioridadTurno,
  PropuestaSiguiente,
  RespuestaGenerarTurno,
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

export async function listarCola(): Promise<FilaCola[]> {
  const { data, error } = await supabase.from('vista_cola_espera').select('*')
  if (error) throw traducirError(error)
  return (data ?? []) as FilaCola[]
}

/**
 * Los turnos en curso, para la consola del operador.
 *
 * El operador tiene sesión, así que la RLS le deja leer la vista. Esta
 * función NO se usa desde la pantalla pública: allí no hay sesión, y la
 * RLS lo negaría (ver `listarUltimasLlamadas`).
 */
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

/** Formatea una marca de tiempo en `America/Mazatlan` (RG-001). */
export function formatearFechaHora(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mazatlan',
    dateStyle: 'medium',
    timeStyle: 'short',
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


