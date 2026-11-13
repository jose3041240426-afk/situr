import { useCallback, useEffect, useState } from 'react'
import BotonChispa from '../components/BotonChispa'
import BotonEmitir from '../components/BotonEmitir'
import CodigoQR from '../components/CodigoQR'
import { Aviso, ChipEstado } from '../components/ui'
import {
  abrirPeriodo,
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
 * Interfaz simplificada con tres secciones:
 *
 *   A. Abrir periodo — control de apertura con selección de fecha.
 *   B. Emitir turno — generación de turnos conforme a las reglas existentes.
 *   C. Atención ahora — vista informativa de los turnos en atención (solo lectura).
 *
 * El rol RECEPCIÓN no puede llamar turnos, finalizar atenciones, cancelar,
 * omitir ni acceder a funciones administrativas.
 */
export default function Recepcion() {
  const { operador } = useAuth()

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
    <div className="space-y-6">
      {/* Encabezado */}
      <header className="tarjeta">
        <div className="px-6 py-5">
          <h1 className="text-lg font-bold text-gris-900">Recepción</h1>
          <p className="mt-1 text-sm text-gris-600">
            {operador?.nombres} · Apertura de periodos, emisión de turnos y consulta de atención.
          </p>
        </div>
      </header>

      {/* Mensajes */}
      {mensaje && (
        <Aviso tono={mensaje.tono}>
          <p className="font-bold">{mensaje.texto}</p>
        </Aviso>
      )}

      {/* ============================================ */}
      {/* A. ABRIR PERIODO                            */}
      {/* ============================================ */}
      <section className="tarjeta">
        <div className="border-b border-gris-100 px-6 py-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
            Abrir periodo
          </h2>
        </div>
        <div className="px-6 py-5">
          {periodoListo ? (
            periodoAbierto ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gris-700">Periodo abierto</p>
                  <p className="mt-1 text-2xl font-bold text-gris-900">
                    {formatearFecha(periodoAbierto.clave)}
                  </p>
                  <p className="mt-1 text-xs text-gris-500">
                    Inicio: {periodoAbierto.hora_inicio ? new Date(periodoAbierto.hora_inicio).toLocaleTimeString('es-MX') : '—'}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${periodoAbierto.estado === 'ABIERTO' ? 'bg-verde-100 text-verde-700' : 'bg-rojo-100 text-rojo-700'}`}>
                  {periodoAbierto.estado === 'ABIERTO' ? 'Abierto' : 'Cerrado'}
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-gris-900">No hay periodo abierto</p>
                  <p className="mt-1 text-xs text-gris-500">
                    Abra el periodo de hoy para comenzar a emitir turnos.
                  </p>
                </div>
                <BotonChispa tono="verde" onClick={() => void abrir()} disabled={ocupado}>
                  Abrir periodo de hoy
                </BotonChispa>
              </div>
            )
          ) : (
            <p className="text-sm text-gris-500">Cargando estado del periodo…</p>
          )}
        </div>
      </section>

      {/* ============================================ */}
      {/* B. EMITIR TURNO                             */}
      {/* ============================================ */}
      <section className="tarjeta">
        <div className="border-b border-gris-100 px-6 py-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
            Emitir turno
          </h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          {!periodoAbierto && periodoListo && (
            <Aviso tono="alerta">
              <p className="text-sm">
                Abra un periodo operativo antes de emitir turnos.
              </p>
            </Aviso>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-gris-700">
              Trámite
            </label>
            <select
              value={tramiteId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTramiteId(e.target.value)}
              disabled={!periodoAbierto || ocupado}
              className="w-full rounded-lg border border-gris-300 bg-white px-3 py-2 text-sm text-gris-900 focus:border-azul-500 focus:outline-none focus:ring-1 focus:ring-azul-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">— Seleccione un trámite —</option>
              {tramitesActivos.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.prefijo} — {t.denominacion}
                </option>
              ))}
            </select>
          </div>

          <BotonEmitir
            onClick={() => void emitir()}
            disabled={ocupado || !tramiteId || !periodoAbierto}
          >
            Emitir turno
          </BotonEmitir>

          {/* Último turno emitido con QR */}
          {ultimoTurno && (
            <div className="mt-4 rounded-lg border border-gris-200 bg-gris-50 p-4">
              <p className="mb-2 text-sm font-bold text-gris-900">
                Turno {ultimoTurno.codigo}
              </p>
              <CodigoQR valor={ultimoTurno.token} tamano={160} />
            </div>
          )}
        </div>
      </section>

      {/* ============================================ */}
      {/* C. ATENCIÓN AHORA (solo lectura)            */}
      {/* ============================================ */}
      <section className="tarjeta">
        <div className="border-b border-gris-100 px-6 py-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
            Atención ahora
          </h2>
          <p className="mt-1 text-xs text-gris-500">
            Vista informativa — no se pueden realizar acciones desde aquí.
          </p>
        </div>
        <div className="px-6 py-5">
          {actuales.length === 0 ? (
            <p className="text-sm text-gris-500">
              No hay turnos en atención en este momento.
            </p>
          ) : (
            <div className="space-y-3">
              {actuales.map((t) => (
                <div
                  key={t.turno_id}
                  className="flex items-center justify-between rounded-lg border border-gris-200 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gris-900">
                      {t.codigo_turno}
                    </p>
                    <p className="text-xs text-gris-500 truncate">
                      {t.denominacion_tramite}
                    </p>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    {t.denominacion_modulo && (
                      <span className="whitespace-nowrap text-xs text-gris-500">
                        {t.denominacion_modulo}
                      </span>
                    )}
                    <ChipEstado estado={t.estado} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
