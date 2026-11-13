import { useCallback, useEffect, useMemo, useState } from 'react'
import BotonChispa from '../components/BotonChispa'
import BotonEmitir from '../components/BotonEmitir'
import CodigoQR from '../components/CodigoQR'
import Paginador from '../components/Paginador'
import { Aviso, ChipEstado, Esqueleto, Vacio } from '../components/ui'
import { Avatar } from '../components/ui/avatar'
import {
  ErrorSitur,
  abrirPeriodo,
  formatearFecha,
  formatearFechaHora,
  generarTurno,
  listarHistorialPaginado,
  listarTramites,
  listarTurnosActuales,
  obtenerPeriodoAbierto,
  type TurnoHistorialPaginado,
} from '../lib/rpc'
import type { FilaActual, PeriodoOperativo, Tramite } from '../lib/tipos'
import { ETIQUETA_ESTADO } from '../lib/tipos'
import { useAuth } from '../lib/auth'

/**
 * SITUR — Pantalla de RECEPCIÓN.
 *
 * Interfaz simplificada con estilo moderno basado en la referencia visual:
 * header azul con gradiente, tarjetas con bordes redondeados y sombras,
 * layout en grid de 2 columnas.
 *
 * Secciones:
 *   A. Abrir periodo — control de apertura con selección de fecha.
 *   B. Emitir turno — generación de turnos conforme a las reglas existentes.
 *   C. Atención ahora — vista informativa de los turnos en atención (solo lectura).
 *   D. Historial — consulta paginada de turnos emitidos.
 *   E. Perfil (Turnos) — información del operador con estadísticas de turnos.
 *
 * El rol RECEPCIÓN no puede llamar turnos, finalizar atenciones, cancelar,
 * omitir ni acceder a funciones administrativas.
 */
const POR_PAGINA = 10

function hoyISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function ahoraReloj(): string {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
}

function ahoraFecha(): string {
  const d = new Date()
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
  return `${dias[d.getDay()]}, ${d.getDate()}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

/**
 * Icono SVG para Abrir periodo
 */
function IconoCalendario() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

/**
 * Icono SVG para Emitir turno
 */
function IconoSurtidor() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    </svg>
  )
}

/**
 * Icono SVG para Atención ahora
 */
function IconoAtencion() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  )
}

/**
 * Icono SVG para Historial
 */
function IconoHistorial() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

/**
 * Icono SVG para Perfil
 */
function IconoPerfil() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  )
}

/**
 * Icono SVG para reloj (vacío)
 */
function IconoReloj() {
  return (
    <svg className="w-12 h-12 text-azul-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

/**
 * Tarjeta de sección con estilo moderno
 */
function TarjetaSeccion({
  titulo,
  icono,
  badge,
  children,
  className,
}: {
  titulo: string
  icono: React.ReactNode
  badge?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`recepcion-tarjeta ${className || ''}`}>
      <div className="recepcion-tarjeta-header">
        <div className="flex items-center gap-2.5">
          <span className="recepcion-icono">{icono}</span>
          <h2 className="recepcion-tarjeta-titulo">{titulo}</h2>
        </div>
        {badge && <div>{badge}</div>}
      </div>
      <div className="recepcion-tarjeta-cuerpo">
        {children}
      </div>
    </section>
  )
}

/**
 * Chip de estado para RECEPCIÓN
 */
function ChipRecepcion({ texto, tono }: { texto: string; tono: 'verde' | 'azul' | 'gris' }) {
  const clases = {
    verde: 'bg-emerald-100 text-emerald-700 ring-emerald-600/20',
    azul: 'bg-blue-100 text-blue-700 ring-blue-600/20',
    gris: 'bg-slate-100 text-slate-600 ring-slate-500/10',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset ${clases[tono]}`}>
      {tono === 'verde' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
      {texto}
    </span>
  )
}

export default function Recepcion() {
  const { operador, sesion } = useAuth()

  // ------------------------------------------------------------------ Estado

  const [periodoAbierto, setPeriodoAbierto] = useState<PeriodoOperativo | null>(null)
  const [periodoListo, setPeriodoListo] = useState(false)
  const [tramites, setTramites] = useState<Tramite[]>([])
  const [tramiteId, setTramiteId] = useState('')
  const [actuales, setActuales] = useState<FilaActual[]>([])
  const [ocupado, setOcupado] = useState(false)
  const [mensaje, setMensaje] = useState<{ texto: string; tono: 'ok' | 'peligro' | 'alerta' } | null>(null)
  const [ultimoTurno, setUltimoTurno] = useState<{ codigo: string; token: string } | null>(null)
  const [reloj, setReloj] = useState(ahoraReloj())
  const [fechaStr, setFechaStr] = useState(ahoraFecha())

  // Historial state
  const [turnosHistorial, setTurnosHistorial] = useState<TurnoHistorialPaginado[]>([])
  const [totalHistorial, setTotalHistorial] = useState(0)
  const [paginaHistorial, setPaginaHistorial] = useState(1)
  const [cargandoHistorial, setCargandoHistorial] = useState(true)
  const [errorHistorial, setErrorHistorial] = useState<string | null>(null)
  const [fechaInput, setFechaInput] = useState(hoyISO)
  const [filtroInput, setFiltroInput] = useState('')
  const [fechaAplicada, setFechaAplicada] = useState(hoyISO)
  const [filtroAplicado, setFiltroAplicado] = useState('')

  // ------------------------------------------------------------------ Carga

  const cargar = useCallback(async () => {
    try {
      const [p, ts, a] = await Promise.all([
        obtenerPeriodoAbierto(),
        listarTramites(),
        listarTurnosActuales(),
      ])
      setPeriodoAbierto(p)
      setPeriodoListo(true)
      setTramites(ts)
      setActuales(a)
    } catch (err) {
      console.error('Recepción: error al cargar', err)
    }
  }, [])

  useEffect(() => {
    void cargar()
    const id = setInterval(cargar, 15_000)
    return () => clearInterval(id)
  }, [cargar])

  // Reloj en tiempo real
  useEffect(() => {
    const id = setInterval(() => {
      setReloj(ahoraReloj())
      setFechaStr(ahoraFecha())
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // ------------------------------------------------------------------ Historial

  const cargarHistorial = useCallback(
    async (fecha: string, filtro: string, pag: number) => {
      setCargandoHistorial(true)
      setErrorHistorial(null)
      try {
        const r = await listarHistorialPaginado(fecha, filtro || undefined, pag, POR_PAGINA)
        setTurnosHistorial(r.turnos)
        setTotalHistorial(r.total)
      } catch (e) {
        setErrorHistorial(e instanceof ErrorSitur ? e.message : 'No se pudo cargar el historial.')
      } finally {
        setCargandoHistorial(false)
      }
    },
    [],
  )

  useEffect(() => {
    void cargarHistorial(fechaAplicada, filtroAplicado, paginaHistorial)
  }, [cargarHistorial, fechaAplicada, filtroAplicado, paginaHistorial])

  function aplicarFiltrosHistorial() {
    setPaginaHistorial(1)
    setFechaAplicada(fechaInput || hoyISO())
    setFiltroAplicado(filtroInput.trim())
  }

  // ------------------------------------------------------------------ Acciones

  async function abrir() {
    const hoy = new Date().toISOString().slice(0, 10)
    setOcupado(true)
    try {
      await abrirPeriodo(hoy)
      setMensaje({ texto: `Periodo ${hoy} abierto correctamente.`, tono: 'ok' })
      await cargar()
    } catch (err) {
      setMensaje({ texto: (err as Error).message, tono: 'peligro' })
    } finally {
      setOcupado(false)
    }
  }

  async function emitir() {
    if (!tramiteId) {
      setMensaje({ texto: 'Seleccione un trámite para emitir el turno.', tono: 'alerta' })
      return
    }
    setOcupado(true)
    try {
      const resultado = await generarTurno(tramiteId)
      setUltimoTurno({ codigo: resultado.codigo_turno, token: resultado.token_publico })
      setMensaje({ texto: `Turno ${resultado.codigo_turno} emitido correctamente.`, tono: 'ok' })
      await cargar()
    } catch (err) {
      setMensaje({ texto: (err as Error).message, tono: 'peligro' })
    } finally {
      setOcupado(false)
    }
  }

  // ------------------------------------------------------------------ Render

  const tramitesActivos = tramites.filter((t) => t.activo)

  // Contar turnos emitidos por el operador hoy (del historial)
  const turnosEmitidosHoy = useMemo(() => {
    return turnosHistorial.length
  }, [turnosHistorial])

  return (
    <div className="recepcion-layout">
      {/* ============================================ */}
      {/* HEADER AZUL CON GRADIENTE                    */}
      {/* ============================================ */}
      <header className="recepcion-header">
        <div className="recepcion-header-content">
          <div>
            <p className="recepcion-header-subtitulo">PANEL DE PERSONAL</p>
            <h1 className="recepcion-header-titulo">Recepción</h1>
            <p className="recepcion-header-descripcion">
              Apertura de periodos, emisión de turnos y consulta de atención.
            </p>
          </div>
          <div className="text-right">
            <p className="recepcion-header-reloj">{reloj}</p>
            <p className="recepcion-header-fecha">{fechaStr}</p>
            <div className="mt-1 inline-flex items-center justify-center">
              <Avatar nombre={operador?.nombres ?? 'Recepción'} tamano="sm" />
            </div>
          </div>
        </div>
      </header>

      {/* ============================================ */}
      {/* CONTENIDO PRINCIPAL                          */}
      {/* ============================================ */}
      <main className="recepcion-main">
        {/* Mensajes */}
        {mensaje && (
          <Aviso tono={mensaje.tono}>
            <p className="font-bold">{mensaje.texto}</p>
          </Aviso>
        )}

        {/* ============================================ */}
        {/* GRID: ABRIR PERIODO + EMITIR TURNO           */}
        {/* ============================================ */}
        <div className="recepcion-grid">
          {/* A. ABRIR PERIODO */}
          <TarjetaSeccion
            titulo="Abrir periodo"
            icono={<IconoCalendario />}
            badge={periodoAbierto ? <ChipRecepcion texto="Abierto" tono="verde" /> : <ChipRecepcion texto="Cerrado" tono="gris" />}
          >
            {periodoListo ? (
              periodoAbierto ? (
                <div className="recepcion-periodo-abierto">
                  <div className="recepcion-periodo-dato">
                    <span className="recepcion-periodo-label">Periodo abierto</span>
                    <span className="recepcion-periodo-fecha">{formatearFecha(periodoAbierto.clave)}</span>
                  </div>
                  <div className="recepcion-periodo-dato">
                    <span className="recepcion-periodo-label">Inicio</span>
                    <span className="recepcion-periodo-hora">
                      {periodoAbierto.hora_inicio ? new Date(periodoAbierto.hora_inicio).toLocaleTimeString('es-MX') : '—'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="recepcion-periodo-cerrado">
                  <div>
                    <p className="text-sm font-bold text-slate-900">No hay periodo abierto</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Abra el periodo de hoy para comenzar a emitir turnos.
                    </p>
                  </div>
                  <BotonChispa tono="verde" onClick={() => void abrir()} disabled={ocupado}>
                    Abrir periodo de hoy
                  </BotonChispa>
                </div>
              )
            ) : (
              <Esqueleto filas={2} />
            )}
          </TarjetaSeccion>

          {/* B. EMITIR TURNO */}
          <TarjetaSeccion titulo="Emitir turno" icono={<IconoSurtidor />}>
            <div className="space-y-4">
              {!periodoAbierto && periodoListo && (
                <Aviso tono="alerta">
                  <p className="text-sm">Abra un periodo operativo antes de emitir turnos.</p>
                </Aviso>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">Trámite</label>
                <div className="relative">
                  <select
                    value={tramiteId}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTramiteId(e.target.value)}
                    disabled={!periodoAbierto || ocupado}
                    className="recepcion-select"
                  >
                    <option value="">— Seleccione un trámite —</option>
                    {tramitesActivos.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.prefijo} — {t.denominacion}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <BotonEmitir
                onClick={() => void emitir()}
                disabled={ocupado || !tramiteId || !periodoAbierto}
              >
                Emitir turno
              </BotonEmitir>

              {/* Último turno emitido con QR */}
              {ultimoTurno && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="mb-2 text-sm font-bold text-slate-900">
                    Turno {ultimoTurno.codigo}
                  </p>
                  <CodigoQR valor={ultimoTurno.token} tamano={160} />
                </div>
              )}
            </div>
          </TarjetaSeccion>
        </div>

        {/* ============================================ */}
        {/* GRID: ATENCIÓN AHORA + PERFIL (TURNO)        */}
        {/* ============================================ */}
        <div className="recepcion-grid">
          {/* C. ATENCIÓN AHORA */}
          <TarjetaSeccion
            titulo="Atención ahora"
            icono={<IconoAtencion />}
            badge={<ChipRecepcion texto="Solo lectura" tono="azul" />}
          >
            <p className="mb-3 text-xs text-slate-500">
              Vista informativa — no se pueden realizar acciones desde aquí.
            </p>
            {actuales.length === 0 ? (
              <div className="recepcion-vacio">
                <IconoReloj />
                <p className="recepcion-vacio-texto">
                  No hay turnos en atención en este momento.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {actuales.map((t) => (
                  <div
                    key={t.turno_id}
                    className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900">{t.codigo_turno}</p>
                      <p className="text-xs text-slate-500 truncate">{t.denominacion_tramite}</p>
                    </div>
                    <div className="ml-4 flex items-center gap-2">
                      {t.denominacion_modulo && (
                        <span className="whitespace-nowrap text-xs text-slate-500">
                          {t.denominacion_modulo}
                        </span>
                      )}
                      <ChipEstado estado={t.estado} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TarjetaSeccion>

          {/* E. PERFIL (TURNO) — Info del operador */}
          <TarjetaSeccion titulo="Mi perfil" icono={<IconoPerfil />}>
            <div className="space-y-4">
              {/* Avatar y nombre */}
              <div className="flex items-center gap-4">
                <Avatar nombre={operador?.nombres ?? 'Recepción'} tamano="xl" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900 truncate">
                    {operador?.nombres ?? 'Personal de recepción'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {sesion?.user?.email ?? 'recepcion@catastro.gob.mx'}
                  </p>
                  {operador?.modulo && (
                    <p className="text-xs text-slate-500">Módulo {operador.modulo}</p>
                  )}
                </div>
              </div>

              {/* Estadísticas de turnos */}
              <div className="rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 p-4 ring-1 ring-blue-100">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Turnos del día</p>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-2xl font-black text-blue-900">{turnosEmitidosHoy}</p>
                    <p className="text-xs text-blue-600">Emitidos hoy</p>
                  </div>
                  <div>
                    <p className="text-2xl font-black text-indigo-900">{actuales.length}</p>
                    <p className="text-xs text-indigo-600">En atención</p>
                  </div>
                </div>
              </div>

              {/* Rol */}
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rol</span>
                <ChipRecepcion texto="Recepción" tono="azul" />
              </div>

              {/* Estado del periodo */}
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Periodo</span>
                {periodoAbierto ? (
                  <ChipRecepcion texto="Abierto" tono="verde" />
                ) : (
                  <ChipRecepcion texto="Cerrado" tono="gris" />
                )}
              </div>
            </div>
          </TarjetaSeccion>
        </div>

        {/* ============================================ */}
        {/* D. HISTORIAL DE TURNOS                       */}
        {/* ============================================ */}
        <TarjetaSeccion titulo="Historial de turnos" icono={<IconoHistorial />}>
          {/* Filtros */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-slate-700">Fecha</label>
              <input
                type="date"
                value={fechaInput}
                onChange={(e) => setFechaInput(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-slate-700">Buscar código</label>
              <input
                type="text"
                value={filtroInput}
                onChange={(e) => setFiltroInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') aplicarFiltrosHistorial() }}
                placeholder="Ej: C-001"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <BotonChispa tono="verde" onClick={aplicarFiltrosHistorial}>
              Buscar
            </BotonChispa>
          </div>

          {errorHistorial && (
            <Aviso tono="peligro">
              <p className="text-sm">{errorHistorial}</p>
            </Aviso>
          )}

          {/* Lista de turnos */}
          {cargandoHistorial ? (
            <Esqueleto filas={5} />
          ) : turnosHistorial.length === 0 ? (
            <Vacio titulo="No hay turnos" detalle="No se encontraron turnos para la fecha seleccionada." />
          ) : (
            <>
              <div className="space-y-3">
                {turnosHistorial.map((turno) => (
                  <div
                    key={turno.turno_id}
                    className="overflow-hidden rounded-lg border border-slate-200 bg-white"
                  >
                    {/* Cabecera del turno */}
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="text-sm font-bold text-slate-900">{turno.codigo_turno}</span>
                        <span className="ml-2 text-xs text-slate-500">{turno.denominacion_tramite}</span>
                      </div>
                      <ChipEstado estado={turno.estado_actual} />
                    </div>
                    {/* Transiciones */}
                    <div className="px-4 py-2.5">
                      {turno.transiciones.map((tr, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-slate-600">
                          <span className="shrink-0 font-mono text-[11px] text-slate-400">
                            {formatearFechaHora(tr.fecha)}
                          </span>
                          <span className="font-medium">{ETIQUETA_ESTADO[tr.estado_nuevo] ?? tr.estado_nuevo}</span>
                          {tr.motivo && <span className="text-slate-400">— {tr.motivo}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {/* Paginador */}
              <div className="mt-4">
                <Paginador
                  pagina={paginaHistorial}
                  total={totalHistorial}
                  porPagina={POR_PAGINA}
                  onCambiar={(p: number) => setPaginaHistorial(p)}
                />
              </div>
            </>
          )}
        </TarjetaSeccion>
      </main>
    </div>
  )
}
