import { useCallback, useEffect, useState } from 'react'
import BloqueExpandible from '../components/BloqueExpandible'
import BotonChispa from '../components/BotonChispa'
import BotonEmitir from '../components/BotonEmitir'
import BotonRepartir from '../components/BotonRepartir'
import CodigoQR from '../components/CodigoQR'
import { Aviso, ChipEstado, Esqueleto } from '../components/ui'
import {
  abrirPeriodo,
  cerrarPeriodo,
  formatearFecha,
  generarTurno,
  generarTurnosMasivos,
  listarTramites,
  listarTurnosActuales,
  obtenerPeriodoAbierto,
} from '../lib/rpc'
import type { FilaActual, LoteTurnos, PeriodoOperativo, Tramite } from '../lib/tipos'
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

/**
 * Emisión masiva adaptada al estilo de RECEPCIÓN.
 *
 * Reutiliza la misma lógica que Consola.tsx pero con los componentes
 * y estilos de recepción (select nativo, tarjetas, etc.).
 */
function EmisionMasivaRecepcion({
  tramites,
  lotes,
  onCambiar,
  onEmitir,
  ocupado,
  periodoAbierto,
}: {
  tramites: Tramite[]
  lotes: LoteTurnos[]
  onCambiar: (l: LoteTurnos[]) => void
  onEmitir: () => void
  ocupado: boolean
  periodoAbierto: PeriodoOperativo | null
}) {
  const [total, setTotal] = useState('100')
  const [repartos, setRepartos] = useState(0)

  const filas = lotes.length > 0
    ? lotes
    : tramites.slice(0, 2).map((t) => ({ tramite: t.clave, cantidad: 0 }))
  const suma = filas.reduce((n, l) => n + (Number(l.cantidad) || 0), 0)

  function cambiarCantidad(clave: string, cantidad: number) {
    const base = filas.map((l) => (l.tramite === clave ? { ...l, cantidad } : l))
    onCambiar(base)
  }

  function repartir(totalTexto: string) {
    const n = Math.max(0, Math.floor(Number(totalTexto) || 0))
    if (filas.length === 0) return
    const porCabeza = Math.floor(n / filas.length)
    const sobrante = n - porCabeza * filas.length
    onCambiar(
      filas.map((l, i) => ({ ...l, cantidad: porCabeza + (i === 0 ? sobrante : 0) })),
    )
    setRepartos((n) => n + 1)
  }

  return (
    <div className="space-y-4">
      {/* Repartir total */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Repartir un total (opcional)
          </label>
          <div className="flex gap-1.5">
            <input
              type="number"
              min={1}
              className="recepcion-select flex-1"
              placeholder="ej. 100"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
            <BotonRepartir
              onClick={() => repartir(total)}
              disabled={!total || Number(total) <= 0 || !periodoAbierto || ocupado}
              className="shrink-0"
            >
              Repartir
            </BotonRepartir>
          </div>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        Escriba cuántos quiere de cada trámite, o un total y pulse «Repartir»
        para dividirlo en partes iguales.
      </p>

      {/* Filas por trámite */}
      <div className="space-y-2">
        {filas.map((l) => {
          const t = tramites.find((x) => x.clave === l.tramite)
          return (
            <div
              key={l.tramite}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <label className="min-w-0 flex-1 truncate text-xs text-slate-700">
                <span className="font-semibold">{l.tramite}</span>
                {t ? ` — ${t.denominacion}` : ''}
              </label>
              <div className="contador-turnos shrink-0">
                <button
                  type="button"
                  onClick={() => cambiarCantidad(l.tramite, Math.max(0, l.cantidad - 1))}
                  disabled={l.cantidad <= 0 || !periodoAbierto || ocupado}
                  aria-label={`Restar uno a ${l.tramite}`}
                  className="contador-turnos-boton"
                >
                  <span className="contador-turnos-signo" aria-hidden="true" />
                </button>
                <input
                  key={`${l.tramite}-${repartos}`}
                  type="number"
                  min={0}
                  aria-label={`Cantidad para ${l.tramite}`}
                  className={`contador-turnos-valor ${
                    repartos > 0 && l.cantidad > 0 ? 'cifra-sube' : ''
                  }`}
                  value={l.cantidad}
                  onChange={(e) => cambiarCantidad(l.tramite, Number(e.target.value) || 0)}
                  disabled={!periodoAbierto || ocupado}
                />
                <button
                  type="button"
                  onClick={() => cambiarCantidad(l.tramite, l.cantidad + 1)}
                  disabled={!periodoAbierto || ocupado}
                  aria-label={`Sumar uno a ${l.tramite}`}
                  className="contador-turnos-boton"
                >
                  <span className="contador-turnos-signo contador-turnos-signo--mas" aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => onCambiar(filas.filter((x) => x.tramite !== l.tramite))}
                disabled={!periodoAbierto || ocupado}
                aria-label={`Sacar ${l.tramite} del reparto`}
                className="boton-quitar-reparto shrink-0"
              >
                <span className="icono-papelera" aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Añadir trámites */}
      <div className="flex flex-col items-center gap-2">
        {tramites.length > filas.length && (
          <div className="w-full">
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Añadir otro trámite
            </label>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  onCambiar([...filas, { tramite: e.target.value, cantidad: 0 }])
                }
              }}
              disabled={!periodoAbierto || ocupado}
              className="recepcion-select w-full"
            >
              <option value="">Añadir otro trámite…</option>
              {tramites
                .filter((t) => !filas.some((l) => l.tramite === t.clave))
                .map((t) => (
                  <option key={t.id} value={t.clave}>
                    {t.clave} — {t.denominacion}
                  </option>
                ))}
            </select>
          </div>
        )}
        {tramites.length > 0 && (
          <button
            type="button"
            onClick={() =>
              tramites.length > filas.length
                ? onCambiar(
                    tramites.map((t) => {
                      const ya = filas.find((l) => l.tramite === t.clave)
                      return { tramite: t.clave, cantidad: ya ? ya.cantidad : 0 }
                    }),
                  )
                : onCambiar([])
            }
            disabled={!periodoAbierto || ocupado}
            className={`rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${
              tramites.length > filas.length
                ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                : 'bg-red-50 text-red-600 hover:bg-red-100'
            } disabled:opacity-50`}
          >
            {tramites.length > filas.length ? 'Añadir todos' : 'Quitar todos'}
          </button>
        )}
      </div>

      {/* Total */}
      <div className="flex items-center justify-between border-t border-slate-200 pt-3">
        <span className="text-xs text-slate-600">Total a emitir</span>
        <span className="text-lg font-black text-slate-900">{suma}</span>
      </div>

      <BotonEmitir
        onClick={onEmitir}
        disabled={ocupado || suma <= 0 || !periodoAbierto}
      >
        {suma > 0 ? `Emitir ${suma} turnos` : 'Emitir lote'}
      </BotonEmitir>
      <p className="text-[11px] leading-snug text-slate-500">
        Si un trámite del lote falla, no se emite ninguno: el lote es completo o no
        existe.
      </p>
    </div>
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

  // Emisión masiva (lote)
  const [modoMasivo, setModoMasivo] = useState(false)
  const [lotes, setLotes] = useState<LoteTurnos[]>([])
  const [loteEmitido, setLoteEmitido] = useState<
    { total: number; turnos: Array<{ codigo: string; tramite: string }> } | null
  >(null)

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

  /** Emite un lote de turnos (migración 009). */
  async function emitirMasivo() {
    const pedido = lotes.filter((l) => l.cantidad > 0)
    if (pedido.length === 0) return
    setOcupado(true)
    try {
      const r = await generarTurnosMasivos(pedido)
      setLoteEmitido({
        total: r.total,
        turnos: r.turnos.map((t) => ({ codigo: t.codigo, tramite: t.tramite })),
      })
      setLotes([])
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

              {/* Toggle: Un turno / Varios turnos */}
              <div
                className="glass-radio-group"
                role="radiogroup"
                aria-label="Modo de emisión"
              >
                <input
                  type="radio"
                  name="modo-emision-recepcion"
                  id="modo-un-turno-recepcion"
                  checked={!modoMasivo}
                  onChange={() => setModoMasivo(false)}
                />
                <label htmlFor="modo-un-turno-recepcion">Un turno</label>

                <input
                  type="radio"
                  name="modo-emision-recepcion"
                  id="modo-varios-turnos-recepcion"
                  checked={modoMasivo}
                  onChange={() => setModoMasivo(true)}
                />
                <label htmlFor="modo-varios-turnos-recepcion">Varios turnos</label>

                <div className="glass-glider" aria-hidden="true" />
              </div>

              <BloqueExpandible clave={modoMasivo}>
                {!modoMasivo ? (
                  /* Emisión simple: un turno */
                  <div className="space-y-4">
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
                ) : (
                  /* Emisión masiva: lote */
                  <EmisionMasivaRecepcion
                    tramites={tramitesActivos}
                    lotes={lotes}
                    onCambiar={setLotes}
                    onEmitir={() => void emitirMasivo()}
                    ocupado={ocupado}
                    periodoAbierto={periodoAbierto}
                  />
                )}
              </BloqueExpandible>

              {/* Resumen del último lote emitido */}
              {loteEmitido && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <p className="mb-2 text-sm font-bold text-emerald-800">
                    Lote emitido: {loteEmitido.total} turnos
                  </p>
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {loteEmitido.turnos.map((t, i) => (
                      <p key={i} className="text-xs text-emerald-700">
                        {t.codigo} — {t.tramite}
                      </p>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLoteEmitido(null)}
                    className="mt-2 text-xs text-emerald-600 underline hover:text-emerald-800"
                  >
                    Cerrar
                  </button>
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
