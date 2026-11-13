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
 * Diseño basado en RecepcionDashboard.tsx de referencia:
 * fondo light, header con gradiente navy, grid 2x2 con tarjetas blancas.
 *
 * Secciones:
 *   A. Abrir / Cerrar periodo
 *   B. Emitir turno (simple y masivo)
 *   C. Atención ahora (solo lectura)
 */

const C = {
  bg: '#EAF1FB',
  panel: '#FFFFFF',
  navy: '#0B2A5B',
  blue900: '#123C7C',
  blue700: '#1D4ED8',
  blue600: '#2563EB',
  blue500: '#3B82F6',
  blue200: '#BFDBFE',
  blue100: '#DBEAFE',
  blue50: '#EFF6FF',
  text: '#0F2547',
  muted: '#5B7399',
  line: '#D5E2F5',
}

const font = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif'

/**
 * Icono SVG genérico
 */
function Svg({ d, size = 28 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/**
 * Badge reutilizable
 */
function Badge({ label, dot, dark }: { label: string; dot?: boolean; dark?: boolean }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 20px',
        borderRadius: 999,
        fontSize: 22,
        fontWeight: 600,
        background: dark ? C.blue600 : C.blue100,
        color: dark ? '#fff' : C.blue700,
      }}
    >
      {dot && <span style={{ width: 12, height: 12, borderRadius: 99, background: dark ? '#fff' : C.blue500 }} />}
      {label}
    </div>
  )
}

/**
 * Tarjeta Card del diseño de referencia
 */
function Card({
  title,
  icon,
  right,
  children,
  style,
}: {
  title: string
  icon: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div
      style={{
        background: C.panel,
        borderRadius: 28,
        border: `1px solid ${C.line}`,
        boxShadow: '0 20px 50px rgba(18,60,124,0.10)',
        padding: 32,
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: C.blue100,
            color: C.blue700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
        <div style={{ fontSize: 32, fontWeight: 700, color: C.navy, flex: 1 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  )
}

/**
 * Icono para abrir en otra pestaña
 */
function IconoNuevaPestana() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  )
}

/**
 * Emisión masiva adaptada al estilo de RECEPCIÓN.
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

// ------------------------------------------------------------------ Componente principal

export default function Recepcion() {
  useAuth()

  const [periodoAbierto, setPeriodoAbierto] = useState<PeriodoOperativo | null>(null)
  const [periodoListo, setPeriodoListo] = useState(false)
  const [tramites, setTramites] = useState<Tramite[]>([])
  const [tramiteId, setTramiteId] = useState('')
  const [actuales, setActuales] = useState<FilaActual[]>([])
  const [ocupado, setOcupado] = useState(false)
  const [mensaje, setMensaje] = useState<{ texto: string; tono: 'ok' | 'peligro' | 'alerta' } | null>(null)
  const [ultimoTurno, setUltimoTurno] = useState<{ codigo: string; token: string } | null>(null)

  const [modoMasivo, setModoMasivo] = useState(false)
  const [lotes, setLotes] = useState<LoteTurnos[]>([])
  const [loteEmitido, setLoteEmitido] = useState<
    { total: number; turnos: Array<{ codigo: string; tramite: string }> } | null
  >(null)

  // Reloj
  const [reloj, setReloj] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setReloj(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

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

  const tramitesActivos = tramites.filter((t) => t.activo)

  const horaStr = reloj.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  const fechaStr = reloj.toLocaleDateString('es-MX', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })

  return (
    <div
      style={{
        background: C.bg,
        fontFamily: font,
        color: C.text,
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header con gradiente navy */}
      <div
        style={{
          height: 120,
          flexShrink: 0,
          background: `linear-gradient(120deg, ${C.navy} 0%, ${C.blue900} 55%, ${C.blue600} 100%)`,
          padding: '0 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ fontSize: 14, letterSpacing: 4, color: C.blue200, fontWeight: 600, marginBottom: 6 }}>
            PANEL DE PERSONAL
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, color: '#fff', lineHeight: 1 }}>Recepción</div>
          <div style={{ fontSize: 16, color: C.blue200, marginTop: 8 }}>
            Apertura de periodos, emisión de turnos y consulta de atención.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>{horaStr}</div>
            <div style={{ fontSize: 14, color: C.blue200, textTransform: 'capitalize' }}>{fechaStr}</div>
          </div>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 99,
              background: 'rgba(255,255,255,0.16)',
              border: '2px solid rgba(255,255,255,0.4)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            RP
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: '24px 40px 32px' }}>
        {/* Mensajes */}
        {mensaje && (
          <div className="mb-4">
            <Aviso tono={mensaje.tono}>
              <p className="font-bold">{mensaje.texto}</p>
            </Aviso>
          </div>
        )}

        {/* Botón: abrir turnos en vivo en otra pestaña */}
        <button
          type="button"
          onClick={() => window.open('/admin/turnos-vivos', '_blank')}
          className="mb-4 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          style={{ fontFamily: font }}
        >
          <IconoNuevaPestana />
          Ver turnos en vivo en otra pestaña
        </button>

        {/* Grid 2x2 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridTemplateRows: 'auto auto',
            gap: 32,
          }}
        >
          {/* A. ABRIR / CERRAR PERIODO — izq arriba */}
          <Card
            title="Abrir periodo"
            icon={<Svg d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />}
            right={periodoAbierto ? <Badge label="Abierto" dot dark /> : <Badge label="Cerrado" />}
            style={{ gridColumn: 1, gridRow: 1 }}
          >
            {periodoListo ? (
              periodoAbierto ? (
                <div
                  style={{
                    background: C.blue50,
                    border: `1px solid ${C.blue200}`,
                    borderRadius: 20,
                    padding: '24px 28px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flex: 1,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 18, color: C.muted, fontWeight: 600 }}>Periodo abierto</div>
                    <div style={{ fontSize: 36, fontWeight: 800, color: C.navy, lineHeight: 1.1 }}>
                      {formatearFecha(periodoAbierto.clave)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 18, color: C.muted, fontWeight: 600 }}>Inicio</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: C.blue700 }}>
                      {periodoAbierto.hora_inicio ? new Date(periodoAbierto.hora_inicio).toLocaleTimeString('es-MX') : '—'}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: C.blue50,
                    border: `1px solid ${C.blue200}`,
                    borderRadius: 20,
                    padding: '24px 28px',
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                  }}
                >
                  <p style={{ fontSize: 16, fontWeight: 600, color: C.navy }}>No hay periodo abierto</p>
                  <p style={{ fontSize: 14, color: C.muted, marginTop: 4 }}>
                    Abra el periodo de hoy para comenzar a emitir turnos.
                  </p>
                </div>
              )
            ) : (
              <Esqueleto filas={2} />
            )}
            <div className="mt-4" style={{ width: '100%', marginTop: 'auto' }}>
              {periodoAbierto ? (
                <BotonChispa
                  tono="rojo"
                  onClick={() => void cerrar()}
                  disabled={ocupado}
                >
                  Cerrar periodo
                </BotonChispa>
              ) : (
                <BotonChispa
                  tono="verde"
                  onClick={() => void abrir()}
                  disabled={ocupado}
                >
                  Abrir periodo de hoy
                </BotonChispa>
              )}
            </div>
          </Card>

          {/* B. EMITIR TURNO — derecha, span 2 filas */}
          <Card
            title="Emitir turno"
            icon={<Svg d="M15 5v2M15 11v2M15 17v2M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2z" />}
            style={{ gridColumn: 2, gridRow: '1 / span 2' }}
          >
            {!periodoAbierto && periodoListo && (
              <div className="mb-4">
                <Aviso tono="alerta">
                  <p className="text-sm">Abra un periodo operativo antes de emitir turnos.</p>
                </Aviso>
              </div>
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
                <div className="space-y-4">
                  <div>
                    <label style={{ fontSize: 18, color: C.muted, fontWeight: 600, marginBottom: 12, display: 'block' }}>
                      Trámite
                    </label>
                    <div
                      style={{
                        border: `2px solid ${C.blue500}`,
                        borderRadius: 18,
                        padding: '16px 22px',
                        fontSize: 20,
                        color: C.muted,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        boxShadow: `0 0 0 6px ${C.blue100}`,
                      }}
                    >
                      <select
                        value={tramiteId}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTramiteId(e.target.value)}
                        disabled={!periodoAbierto || ocupado}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          fontSize: 20,
                          color: C.muted,
                          width: '100%',
                          outline: 'none',
                          fontFamily: font,
                          cursor: 'pointer',
                        }}
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

                  <div style={{ marginTop: 20, width: '100%' }}>
                    <BotonEmitir
                      onClick={() => void emitir()}
                      disabled={ocupado || !tramiteId || !periodoAbierto}
                    >
                      Emitir turno
                    </BotonEmitir>
                  </div>

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
          </Card>

          {/* C. ATENCIÓN AHORA — izq abajo */}
          <Card
            title="Atención ahora"
            icon={<Svg d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />}
            right={<Badge label="Solo lectura" />}
            style={{ gridColumn: 1, gridRow: 2 }}
          >
            <div style={{ fontSize: 18, color: C.muted, marginBottom: 20 }}>
              Vista informativa — no se pueden realizar acciones desde aquí.
            </div>
            {actuales.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  border: `2px dashed ${C.blue200}`,
                  borderRadius: 20,
                  background: C.blue50,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 14,
                  minHeight: 120,
                }}
              >
                <div style={{ color: C.blue500 }}>
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </div>
                <div style={{ fontSize: 20, fontWeight: 600, color: C.blue900 }}>
                  No hay turnos en atención en este momento.
                </div>
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
          </Card>
        </div>
      </div>
    </div>
  )
}
