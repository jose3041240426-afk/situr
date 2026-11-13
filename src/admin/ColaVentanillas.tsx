import { useCallback, useEffect, useState } from 'react'
import { estadoVentanillas, solicitarTurnoVentanilla, tokenTurnoParaQr, iniciarAtencion, finalizarTurno, cancelarTurno } from '../lib/rpc'
import type { RespuestaEstadoVentanillas, Ventanilla, FilaColaVentanilla } from '../lib/tipos'
import CodigoQR from '../components/CodigoQR'

const ESTADO_COLOR: Record<string, string> = {
  DISPONIBLE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ATENDIENDO: 'bg-amber-50 text-amber-700 border-amber-200',
  SIN_DISPONIBILIDAD: 'bg-gris-100 text-gris-500 border-gris-200',
}

const ESTADO_TEXTO: Record<string, string> = {
  DISPONIBLE: 'Disponible',
  ATENDIENDO: 'Atendiendo',
  SIN_DISPONIBILIDAD: 'Sin disponibilidad',
}

export default function ColaVentanillas() {
  const [datos, setDatos] = useState<RespuestaEstadoVentanillas | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null) // modulo_id en acción
  const [qrTurno, setQrTurno] = useState<{ turnoId: string; token: string } | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    try {
      const d = await estadoVentanillas()
      setDatos(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar la cola.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()
    const id = window.setInterval(cargar, 4000)
    return () => window.clearInterval(id)
  }, [cargar])

  async function solicitar(moduloId: string) {
    setOcupado(moduloId)
    setAviso(null)
    try {
      const r = await solicitarTurnoVentanilla(moduloId)
      if (r.servido) {
        setAviso(`Turno ${r.codigo_turno} asignado a la ventanilla.`)
      } else {
        setAviso(r.motivo || 'La ventanilla sigue en la cola.')
      }
      await cargar()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo solicitar el turno.')
    } finally {
      setOcupado(null)
    }
  }

  async function verQr(turnoId: string) {
    try {
const t = await tokenTurnoParaQr(turnoId)
      setQrTurno({ turnoId, token: t.token_publico })
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo generar el QR.')
    }
  }

  async function accionTurno(turnoId: string, accion: 'iniciar' | 'finalizar' | 'cancelar') {
    setOcupado(turnoId)
    try {
      if (accion === 'iniciar') await iniciarAtencion(turnoId)
      else if (accion === 'finalizar') await finalizarTurno(turnoId)
      else await cancelarTurno(turnoId, 'Cancelado por el operador.')
      await cargar()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo realizar la acción.')
    } finally {
      setOcupado(null)
    }
  }

  if (cargando) {
    return <div className="p-6 text-gris-500">Cargando cola…</div>
  }

  const cola = datos?.cola ?? []
  const ventanillas = datos?.ventanillas ?? []

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gris-900">Turnos — Cola global</h1>
        {aviso && (
          <div className="rounded-lg border border-azul-200 bg-azul-50 px-4 py-2 text-sm text-azul-700">
            {aviso}
          </div>
        )}
      </header>

      {/* Carrusel horizontal de turnos pendientes */}
      <section className="tarjeta p-4">
        <h2 className="mb-3 text-lg font-semibold text-gris-900">Cola de espera ({cola.length})</h2>
        {error && <p className="text-sm text-rojo-600">{error}</p>}
        {cola.length === 0 ? (
          <p className="text-sm text-gris-500">No hay turnos pendientes.</p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {cola.map((t: FilaColaVentanilla) => (
              <div
                key={t.turno_id}
                className="min-w-[150px] shrink-0 rounded-2xl border border-gris-200 bg-white p-3 shadow-sm"
              >
                <div className="text-xs text-gris-500">Turno {t.posicion}</div>
                <div className="text-xs text-gris-600">{t.tramite_denominacion}</div>
                <div className="text-lg font-bold text-gris-900">{t.codigo_turno}</div>
                <span className="mt-1 inline-block rounded-full bg-gris-100 px-2 py-0.5 text-xs">
                  {t.tramite_clave}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Contenedores de ventanillas */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {ventanillas.map((v: Ventanilla) => (
          <div key={v.modulo_id} className="tarjeta flex flex-col gap-3 p-4" style={{ minHeight: 320 }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-bold text-gris-900">{v.codigo}</div>
                <div className="text-xs text-gris-500">{v.denominacion}</div>
                {v.es_mia && (
                  <span className="mt-1 inline-block rounded-full bg-azul-100 px-2 py-0.5 text-xs font-medium text-azul-700">
                    Tu ventanilla
                  </span>
                )}
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs font-medium ${ESTADO_COLOR[v.estado_ventanilla]}`}
              >
                {ESTADO_TEXTO[v.estado_ventanilla]}
              </span>
            </div>

            {v.turno_codigo ? (
              <div className="rounded-xl bg-gris-50 p-3">
                <div className="text-sm text-gris-500">Turno asignado</div>
                <div className="text-xl font-bold text-gris-900">{v.turno_codigo}</div>
                {v.turno_denominacion_tramite && (
                  <div className="text-xs text-gris-600">{v.turno_denominacion_tramite}</div>
                )}
                {v.minutos_en_ventanilla !== null && (
                  <div className="text-xs text-gris-500">
                    {v.minutos_en_ventanilla} min desde la asignación
                  </div>
                )}
                {v.operador_nombres && (
                  <div className="text-xs text-gris-500">Operador: {v.operador_nombres}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {v.turno_estado === 'CALLED' && (
                    <button
                      className="boton-primario text-xs"
                      disabled={ocupado === v.turno_id! || !v.es_mia}
                      onClick={() => accionTurno(v.turno_id!, 'iniciar')}
                    >
                      Iniciar atención
                    </button>
                  )}
                  {v.turno_estado === 'SERVING' && (
                    <button
                      className="boton-ok text-xs"
                      disabled={ocupado === v.turno_id! || !v.es_mia}
                      onClick={() => accionTurno(v.turno_id!, 'finalizar')}
                    >
                      Finalizar
                    </button>
                  )}
                  <button
                    className="boton-secundario text-xs"
                    disabled={ocupado === v.turno_id!}
                    onClick={() => verQr(v.turno_id!)}
                  >
                    Ver QR
                  </button>
                  <button
                    className="boton-peligro text-xs"
                    disabled={ocupado === v.turno_id! || !v.es_mia}
                    onClick={() => accionTurno(v.turno_id!, 'cancelar')}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gris-500">Sin turno asignado.</p>
            )}

            <button
              className="boton-primario w-full"
              disabled={!v.disponible || !v.es_mia || ocupado === v.modulo_id}
              onClick={() => solicitar(v.modulo_id)}
            >
              {ocupado === v.modulo_id ? 'Solicitando…' : 'Solicitar siguiente turno'}
            </button>
          </div>
        ))}
      </section>

      {qrTurno && (
        <div className="tarjeta flex flex-col items-center gap-3 p-4">
          <h3 className="text-lg font-semibold">Código QR del turno</h3>
          <CodigoQR valor={`${window.location.origin}/turno/${qrTurno.token}`} tamano={200} />
          <button className="boton-secundario text-xs" onClick={() => setQrTurno(null)}>
            Cerrar
          </button>
        </div>
      )}
    </div>
  )
}