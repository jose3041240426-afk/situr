import { useCallback, useEffect, useState } from 'react'
import BotonChispa from '../components/BotonChispa'
import BotonEmitir from '../components/BotonEmitir'
import CodigoQR from '../components/CodigoQR'
import { Aviso, ChipEstado, Esqueleto } from '../components/ui'
import {
  abrirPeriodo,
  cerrarPeriodo,
  formatearFecha,
  generarTurno,
  listarTramites,
  listarTurnosActuales,
  obtenerPeriodoAbierto,
} from '../lib/rpc'
import type { FilaActual, PeriodoOperativo, Tramite } from '../lib/tipos'
import { useAuth } from '../lib/auth'

/**
 * SITUR — Pantalla de RECEPCIÓN.
 *
 * Interfaz simplificada con estilo moderno basado en la referencia visual:
 * header azul con gradiente, tarjetas con bordes redondeados y sombras,
 * layout en grid de 2 columnas.
 *
 * Secciones:
 *   A. Abrir / Cerrar periodo — control de apertura y cierre.
 *   B. Emitir turno — generación de turnos conforme a las reglas existentes.
 *   C. Atención ahora — vista informativa de los turnos en atención (solo lectura).
 *
 * El rol RECEPCIÓN no puede llamar turnos, finalizar atenciones, cancelar,
 * omitir ni acceder a funciones administrativas.
 * El historial y el perfil se acceden desde el menú lateral.
 */

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
 * Icono SVG para reloj (vacío)
 */
function IconoReloj() {
  return (
    <svg className="w-12 h-12 text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
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
  useAuth()

  // ------------------------------------------------------------------ Estado

  const [periodoAbierto, setPeriodoAbierto] = useState<PeriodoOperativo | null>(null)
  const [periodoListo, setPeriodoListo] = useState(false)
  const [tramites, setTramites] = useState<Tramite[]>([])
  const [tramiteId, setTramiteId] = useState('')
  const [actuales, setActuales] = useState<FilaActual[]>([])
  const [ocupado, setOcupado] = useState(false)
  const [mensaje, setMensaje] = useState<{ texto: string; tono: 'ok' | 'peligro' | 'alerta' } | null>(null)
  const [ultimoTurno, setUltimoTurno] = useState<{ codigo: string; token: string } | null>(null)

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

  async function cerrar() {
    if (!periodoAbierto) return
    if (!window.confirm(`¿Cerrar el periodo ${formatearFecha(periodoAbierto.clave)}? Los turnos en espera se omitirán.`)) return
    setOcupado(true)
    try {
      await cerrarPeriodo(periodoAbierto.id)
      setMensaje({ texto: `Periodo ${formatearFecha(periodoAbierto.clave)} cerrado correctamente.`, tono: 'ok' })
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

  return (
    <div className="recepcion-layout">
      {/* Mensajes */}
      {mensaje && (
        <Aviso tono={mensaje.tono}>
          <p className="font-bold">{mensaje.texto}</p>
        </Aviso>
      )}

        {/* ============================================ */}
        {/* GRID: ABRIR / CERRAR PERIODO + EMITIR TURNO  */}
        {/* ============================================ */}
        <div className="recepcion-grid">
          {/* A. ABRIR / CERRAR PERIODO */}
          <TarjetaSeccion
            titulo="Periodo operativo"
            icono={<IconoCalendario />}
            badge={periodoAbierto ? <ChipRecepcion texto="Abierto" tono="verde" /> : <ChipRecepcion texto="Cerrado" tono="gris" />}
          >
            {periodoListo ? (
              periodoAbierto ? (
                <div className="space-y-4">
                  <div className="recepcion-periodo-abierto">
                    <div className="recepcion-periodo-dato">
                      <span className="recepcion-periodo-label">Periodo</span>
                      <span className="recepcion-periodo-fecha">{formatearFecha(periodoAbierto.clave)}</span>
                    </div>
                    <div className="recepcion-periodo-dato">
                      <span className="recepcion-periodo-label">Inicio</span>
                      <span className="recepcion-periodo-hora">
                        {periodoAbierto.hora_inicio ? new Date(periodoAbierto.hora_inicio).toLocaleTimeString('es-MX') : '—'}
                      </span>
                    </div>
                  </div>
                  <BotonChispa tono="rojo" onClick={() => void cerrar()} disabled={ocupado}>
                    Cerrar periodo
                  </BotonChispa>
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
        {/* C. ATENCIÓN AHORA (ancho completo)           */}
        {/* ============================================ */}
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
    </div>
  )
}
