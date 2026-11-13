import { useCallback, useEffect, useState } from 'react'
import BloqueExpandible from '../components/BloqueExpandible'
import BotonChispa from '../components/BotonChispa'
import BotonEmitir from '../components/BotonEmitir'
import BotonRepartir from '../components/BotonRepartir'
import CodigoQR from '../components/CodigoQR'
import { Aviso } from '../components/ui'
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
 * Diseño basado en la referencia visual v3:
 * - Header navy con "Turnos", botón "Ver turnos en vivo", avatar
 * - Tarjeta superior: Periodo operativo con badges (estado, fecha, inicio)
 * - Tarjeta izquierda grande: Emitir turno con toggle, selector, resumen
 * - Tarjeta derecha: Atención ahora con lista de turnos en ventanilla
 * - Fondo: gradiente azul claro
 */

const C = {
  navy: '#0B2A5B',
  blue700: '#1D4ED8',
  blue600: '#2563EB',
  blue500: '#3B82F6',
  blue200: '#BFDBFE',
  blue100: '#DBEAFE',
  blue50: '#EFF6FF',
  text: '#0F2547',
  muted: '#5B7399',
  line: '#D5E2F5',
  bg: '#F0F5FF',
  panel: '#FFFFFF',
  verde: '#10B981',
}

const font = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif'

/**
 * Badge pequeño estilo referencia
 */
function BadgePequeno({ texto, tono = 'azul' }: { texto: string; tono?: 'azul' | 'verde' | 'gris' }) {
  const colores = {
    azul: { bg: C.blue50, text: C.blue700, dot: C.blue500 },
    verde: { bg: '#ECFDF5', text: '#065F46', dot: C.verde },
    gris: { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF' },
  }
  const c = colores[tono]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: c.bg,
        color: c.text,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: c.dot }} />
      {texto}
    </span>
  )
}

/**
 * Badge de información (fecha, inicio)
 */
function BadgeInfo({ icono, etiqueta, valor }: { icono: string; etiqueta: string; valor: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 18px',
        borderRadius: 16,
        background: C.blue50,
        border: `1px solid ${C.blue100}`,
      }}
    >
      <span style={{ fontSize: 16, color: C.blue500 }}>{icono}</span>
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1, color: C.blue700, textTransform: 'uppercase' }}>
          {etiqueta}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.blue700 }}>{valor}</div>
      </div>
    </div>
  )
}

/**
 * Tarjeta blanca con sombra
 */
function Tarjeta({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: C.panel,
        borderRadius: 20,
        boxShadow: '0 4px 20px rgba(18,60,124,0.24), 0 28px 60px -6px rgba(18,60,124,0.45), 0 0 0 1px rgba(18,60,124,0.08)',
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/**
 * Icono de calendario
 */
function IconoCalendario() {
  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: C.blue600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        flexShrink: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    </div>
  )
}

/**
 * Icono de emitir turno
 */
function IconoEmitir() {
  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: C.blue600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        flexShrink: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 5v2M15 11v2M15 17v2M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7a2 2 0 0 1 2-2z" />
      </svg>
    </div>
  )
}

/**
 * Icono de atención
 */
function IconoAtencion() {
  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: C.blue600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        flexShrink: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    </div>
  )
}

/**
 * Tarjeta de turno en atención (estilo referencia)
 */
function TurnoEnAtencion({ turno }: { turno: FilaActual }) {
  const prefijo = turno.codigo_turno.split('-')[0]
  const duracion = turno.llamado_en
    ? (() => {
        const diff = Math.floor((Date.now() - new Date(turno.llamado_en).getTime()) / 60000)
        const min = Math.floor(diff / 60)
        const seg = diff % 60
        return `${String(min).padStart(2, '0')}:${String(seg).padStart(2, '0')} min`
      })()
    : '—'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 14,
        background: C.blue50,
        border: `1px solid ${C.blue100}`,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: C.blue600,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {prefijo}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{turno.codigo_turno}</div>
        <div style={{ fontSize: 12, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {turno.denominacion_tramite}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div
          style={{
            display: 'inline-block',
            padding: '2px 10px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            background: '#fff',
            color: C.blue700,
            border: `1px solid ${C.blue200}`,
          }}
        >
          {turno.denominacion_modulo || 'Ventanilla'}
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{duracion}</div>
      </div>
    </div>
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
  const tramiteSeleccionado = tramitesActivos.find((t) => t.id === tramiteId)

  return (
    <div
      style={{
        fontFamily: font,
        color: C.text,
        minHeight: '100%',
      }}
    >
      {/* Mensajes */}
      {mensaje && (
        <div style={{ padding: '16px 24px 0' }}>
          <Aviso tono={mensaje.tono}>
            <p className="font-bold">{mensaje.texto}</p>
          </Aviso>
        </div>
      )}

      {/* ======================================== */}
      {/* TARJETA SUPERIOR: Periodo operativo      */}
      {/* ======================================== */}
      <Tarjeta style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <IconoCalendario />
            <div style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Periodo operativo</div>
              <div style={{ marginTop: 4 }}>
                {periodoAbierto ? <BadgePequeno texto="Abierto" tono="verde" /> : <BadgePequeno texto="Cerrado" tono="gris" />}
              </div>
            </div>

            {/* Separador vertical */}
            <div style={{ width: 1, height: 40, background: C.line, margin: '0 8px', flexShrink: 0 }} />

            {/* Badges de info */}
            {periodoAbierto && periodoListo && (
              <>
                <BadgeInfo
                  icono=""
                  etiqueta="Periodo"
                  valor={formatearFecha(periodoAbierto.clave)}
                />
                <BadgeInfo
                  icono=""
                  etiqueta="Inicio"
                  valor={periodoAbierto.hora_inicio ? new Date(periodoAbierto.hora_inicio).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
                />
              </>
            )}
            {!periodoAbierto && periodoListo && (
              <div style={{ fontSize: 14, color: C.muted }}>No hay periodo abierto</div>
            )}

            {/* Botón de acción al final */}
            <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
              {periodoAbierto ? (
                <BotonChispa tono="rojo" onClick={() => void cerrar()} disabled={ocupado}>
                  Cerrar periodo
                </BotonChispa>
              ) : periodoListo ? (
                <BotonChispa tono="verde" onClick={() => void abrir()} disabled={ocupado}>
                  Abrir periodo de hoy
                </BotonChispa>
              ) : null}
            </div>
          </div>
        </Tarjeta>

      {/* ======================================== */}
      {/* GRID: Emitir turno + Atención ahora     */}
      {/* ======================================== */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, paddingBottom: 40 }}>

          {/* TARJETA IZQUIERDA: Emitir turno (span 1 columna) */}
          <Tarjeta style={{ height: '500px', display: 'flex', flexDirection: 'column' }}>
            {/* Header de tarjeta */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <IconoEmitir />
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Emitir turno</div>
              </div>

              {/* Toggle: Un turno / Varios turnos */}
              <div
                className="glass-radio-group"
                role="radiogroup"
                aria-label="Modo de emisión"
                style={{ display: 'flex', alignItems: 'center', background: C.blue50, borderRadius: 999, padding: 4 }}
              >
                <input
                  type="radio"
                  name="modo-emision-recepcion"
                  id="modo-un-turno-recepcion"
                  checked={!modoMasivo}
                  onChange={() => setModoMasivo(false)}
                  className="glass-radio-input"
                />
                <label htmlFor="modo-un-turno-recepcion" style={{ fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '6px 14px' }}>Un turno</label>

                <input
                  type="radio"
                  name="modo-emision-recepcion"
                  id="modo-varios-turnos-recepcion"
                  checked={modoMasivo}
                  onChange={() => setModoMasivo(true)}
                  className="glass-radio-input"
                />
                <label htmlFor="modo-varios-turnos-recepcion" style={{ fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '6px 14px' }}>Varios turnos</label>

                <div className="glass-glider" aria-hidden="true" />
              </div>
            </div>

            {!periodoAbierto && periodoListo && (
              <div className="mb-4">
                <Aviso tono="alerta">
                  <p className="text-sm">Abra un periodo operativo antes de emitir turnos.</p>
                </Aviso>
              </div>
            )}

            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            <BloqueExpandible clave={modoMasivo}>
              {!modoMasivo ? (
                <div>
                  {/* Selector de trámite estilo referencia */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: 99, background: C.blue600, color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
                      }}>1</div>
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Elige el trámite</span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        borderRadius: 14,
                        border: `2px solid ${tramiteId ? C.blue500 : C.line}`,
                        background: '#fff',
                        boxShadow: tramiteId ? `0 0 0 4px ${C.blue100}` : 'none',
                      }}
                    >
                      {tramiteSeleccionado && (
                        <div style={{
                          width: 32, height: 32, borderRadius: 8, background: C.blue600, color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0,
                        }}>
                          {tramiteSeleccionado.prefijo}
                        </div>
                      )}
                      <select
                        value={tramiteId}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTramiteId(e.target.value)}
                        disabled={!periodoAbierto || ocupado}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          fontSize: 15,
                          color: tramiteId ? C.text : C.muted,
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

                  {/* Resumen del turno */}
                  {tramiteSeleccionado && (
                    <div
                      style={{
                        padding: '16px 20px',
                        borderRadius: 14,
                        background: C.blue50,
                        border: `1px solid ${C.blue100}`,
                        marginBottom: 20,
                      }}
                    >
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.muted, textTransform: 'uppercase', marginBottom: 10 }}>
                        Resumen del turno
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                          <span style={{ color: C.muted }}>Tipo de emisión</span>
                          <span style={{ fontWeight: 600, color: C.text }}>Un turno</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                          <span style={{ color: C.muted }}>Trámite</span>
                          <span style={{ fontWeight: 600, color: C.text }}>{tramiteSeleccionado.prefijo} — {tramiteSeleccionado.denominacion}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                          <span style={{ color: C.muted }}>Periodo</span>
                          <span style={{ fontWeight: 600, color: C.text }}>{periodoAbierto ? formatearFecha(periodoAbierto.clave) : '—'}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* QR del último turno */}
                  {ultimoTurno && (
                    <div style={{ padding: 16, borderRadius: 14, background: '#F9FAFB', border: '1px solid #E5E7EB', marginBottom: 20 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>Turno {ultimoTurno.codigo}</div>
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
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 mt-4">
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

            {/* Botón emitir al fondo */}
            {!modoMasivo && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 'auto',
                paddingTop: 20,
                borderTop: `1px solid ${C.line}`,
              }}>
                <span style={{ fontSize: 13, color: C.muted }}>
                  {tramiteSeleccionado
                    ? `Se emitirá un turno de ${tramiteSeleccionado.denominacion}`
                    : 'Seleccione un trámite para emitir'}
                </span>
                <div style={{ width: '100%', maxWidth: 200 }}>
                  <BotonEmitir
                    onClick={() => void emitir()}
                    disabled={ocupado || !tramiteId || !periodoAbierto}
                  >
                    Emitir turno
                  </BotonEmitir>
                </div>
              </div>
            )}
          </Tarjeta>

          {/* TARJETA DERECHA: Atención ahora */}
          <Tarjeta style={{ height: '500px', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <IconoAtencion />
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Atención ahora</div>
              </div>
              <BadgePequeno texto="Solo lectura" tono="azul" />
            </div>

            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
              Vista informativa — no se pueden realizar acciones desde aquí.
            </div>

            {/* Badge de conteo */}
            {actuales.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <BadgePequeno texto={`${actuales.length} en atención`} tono="azul" />
              </div>
            )}

            {actuales.length === 0 ? (
              <div
                style={{
                  border: `2px dashed ${C.blue200}`,
                  borderRadius: 16,
                  background: C.blue50,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  minHeight: 200,
                }}
              >
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={C.blue500} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.muted }}>
                  No hay turnos en atención en este momento.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 500, overflowY: 'auto' }}>
                {actuales.map((t) => (
                  <TurnoEnAtencion key={t.turno_id} turno={t} />
                ))}
              </div>
            )}
          </Tarjeta>

        </div>
    </div>
  )
}
