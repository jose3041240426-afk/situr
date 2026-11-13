import { useCallback, useEffect, useState } from 'react'
import { estadoVentanillas, solicitarTurnoVentanilla, llamarTurnoAsignado, iniciarAtencion, finalizarTurno, cancelarTurno } from '../lib/rpc'
import type { RespuestaEstadoVentanillas, Ventanilla, FilaColaVentanilla, TurnoAsignado } from '../lib/tipos'

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
  const [aviso, setAviso] = useState<string | null>(null)
  const [modalTurno, setModalTurno] = useState<TurnoAsignado | null>(null)
  const [modalVentanilla, setModalVentanilla] = useState<Ventanilla | null>(null)
  const [accionando, setAccionando] = useState(false)
  const [timerSegundos, setTimerSegundos] = useState(0)
  const [timerActivo, setTimerActivo] = useState(false)

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

  // Timer del modal
  useEffect(() => {
    if (!timerActivo) return
    const id = window.setInterval(() => {
      setTimerSegundos(s => {
        if (s <= 1) {
          setTimerActivo(false)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [timerActivo])

  function cerrarModal() {
    setModalTurno(null)
    setModalVentanilla(null)
    setTimerActivo(false)
    setTimerSegundos(0)
  }

  async function manejarLlamar() {
    if (!modalTurno) return
    setAccionando(true)
    try {
      await llamarTurnoAsignado(modalTurno.turno_id)
      setAviso(`Turno ${modalTurno.turno_codigo} llamado.`)
      // Iniciar timer de 15 minutos para el aviso
      setTimerSegundos(15 * 60)
      setTimerActivo(true)
      cerrarModal()
      await cargar()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo llamar el turno.')
    } finally {
      setAccionando(false)
    }
  }

  async function manejarIniciarAtencion() {
    if (!modalTurno) return
    setAccionando(true)
    try {
      await iniciarAtencion(modalTurno.turno_id)
      setAviso(`Atención iniciada para ${modalTurno.turno_codigo}.`)
      cerrarModal()
      await cargar()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo iniciar la atención.')
    } finally {
      setAccionando(false)
    }
  }

  async function manejarFinalizar() {
    if (!modalTurno) return
    setAccionando(true)
    try {
      await finalizarTurno(modalTurno.turno_id)
      setAviso(`Turno ${modalTurno.turno_codigo} finalizado.`)
      setTimerActivo(false)
      cerrarModal()
      await cargar()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo finalizar el turno.')
    } finally {
      setAccionando(false)
    }
  }

  async function manejarEliminar() {
    if (!modalTurno) return
    if (!confirm(`¿Eliminar turno ${modalTurno.turno_codigo}?`)) return
    setAccionando(true)
    try {
      await cancelarTurno(modalTurno.turno_id, 'Eliminado por operador')
      setAviso(`Turno ${modalTurno.turno_codigo} eliminado.`)
      setTimerActivo(false)
      cerrarModal()
      await cargar()
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No se pudo eliminar el turno.')
    } finally {
      setAccionando(false)
    }
  }

  function formatoTiempo(segundos: number): string {
    const m = Math.floor(segundos / 60)
    const s = segundos % 60
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }



  if (cargando) {
    return <div className="p-6 text-gris-500">Cargando cola…</div>
  }

  const cola = datos?.cola ?? []
  const ventanillas = datos?.ventanillas ?? []

  // Key para re-disparar la animación escalonada cuando los datos cambian
  const animKey = `${cola.length}-${ventanillas.map(v => v.turno_count).join('-')}`

  return (
    <div key={animKey} className="entrada-escalonada flex flex-col gap-6 p-4 md:p-6">
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
                <div className="text-xs text-gris-600">{t.denominacion_tramite}</div>
                <div className="text-lg font-bold text-gris-900">{t.codigo_turno}</div>
                <span className="mt-1 inline-block rounded-full bg-gris-100 px-2 py-0.5 text-xs">
                  {t.clave_tramite}
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

            {v.turnos_asignados.length > 0 ? (
              <div className="flex flex-col gap-2">
                {v.turnos_asignados.map((t: TurnoAsignado) => (
                  <div key={t.turno_id} className="turno-entrada rounded-xl bg-gris-50 p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xl font-bold text-gris-900">{t.turno_codigo}</div>
                        {t.turno_denominacion_tramite && (
                          <div className="text-xs text-gris-600">{t.turno_denominacion_tramite}</div>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setModalTurno(t)
                          setModalVentanilla(v)
                          setTimerSegundos(0)
                          setTimerActivo(false)
                        }}
                        className="rounded-lg p-2 text-gris-500 hover:bg-gris-200 hover:text-gris-700 transition-colors"
                        title="Opciones del turno"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24">
                          <path d="M0 0h24v24H0z" fill="none" />
                          <path fill="currentColor" fill-rule="evenodd" d="M13.664 6.343c0 .414.336.75.75.75h2.493v2.493a.75.75 0 0 0 1.5 0V6.343a.75.75 0 0 0-.75-.75h-3.243a.75.75 0 0 0-.75.75m3.993 7.321a.75.75 0 0 0-.75.75v2.493h-2.493a.75.75 0 1 0 0 1.5h3.243a.75.75 0 0 0 .75-.75v-3.243a.75.75 0 0 0-.75-.75m-11.314 0a.75.75 0 0 1 .75.75v2.493h2.493a.75.75 0 0 1 0 1.5H6.343a.75.75 0 0 1-.75-.75v-3.243a.75.75 0 0 1 .75-.75m3.993-7.321a.75.75 0 0 1-.75.75H7.093v2.493a.75.75 0 1 1-1.5 0V6.343a.75.75 0 0 1 .75-.75h3.243a.75.75 0 0 1 .75.75" clip-rule="evenodd" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gris-500">Sin turno asignado.</p>
            )}

            <button
              className="boton-primario w-full transition-transform hover:scale-105"
              disabled={v.turno_count >= 3 || !v.es_mia || ocupado === v.modulo_id}
              onClick={() => solicitar(v.modulo_id)}
              title={v.turno_count >= 3 ? 'Límite de 3 turnos alcanzado' : undefined}
            >
              {ocupado === v.modulo_id ? 'Solicitando…' : v.turno_count >= 3 ? 'Límite alcanzado (3/3)' : 'Solicitar siguiente turno'}
            </button>
          </div>
        ))}
      </section>

      {/* Modal de opciones del turno */}
      {modalTurno && modalVentanilla && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 modal-bg-entrada">
          <div className="tarjeta w-full max-w-md p-6 modal-entrada">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-gris-900">
                {modalTurno.turno_codigo} — {modalVentanilla.codigo}
              </h3>
              <button
                onClick={cerrarModal}
                className="rounded-lg p-1 text-gris-400 hover:bg-gris-100 hover:text-gris-600"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24">
                  <path d="M0 0h24v24H0z" fill="none" />
                  <path fill="currentColor" d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4z" />
                </svg>
              </button>
            </div>

            {modalTurno.turno_denominacion_tramite && (
              <p className="mb-4 text-sm text-gris-600">{modalTurno.turno_denominacion_tramite}</p>
            )}

            {/* Timer de aviso */}
            {timerActivo && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
                <div className="text-xs text-amber-600">Aviso al siguiente en</div>
                <div className="text-2xl font-bold text-amber-700 font-mono">
                  {formatoTiempo(timerSegundos)}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {/* Llamar — solo si está ASIGNED */}
              {modalTurno.turno_estado === 'ASIGNED' && (
                <button
                  onClick={manejarLlamar}
                  disabled={accionando}
                  className="boton-primario w-full"
                >
                  {accionando ? 'Procesando…' : 'Llamar turno'}
                </button>
              )}

              {/* Iniciar atención — solo si está CALLED */}
              {modalTurno.turno_estado === 'CALLED' && (
                <button
                  onClick={manejarIniciarAtencion}
                  disabled={accionando}
                  className="boton-primario w-full"
                >
                  {accionando ? 'Procesando…' : 'Iniciar atención'}
                </button>
              )}

              {/* Finalizar — si está CALLED o SERVING */}
              {(modalTurno.turno_estado === 'CALLED' || modalTurno.turno_estado === 'SERVING') && (
                <button
                  onClick={manejarFinalizar}
                  disabled={accionando}
                  className="w-full rounded-lg border border-gris-300 bg-white px-4 py-2.5 text-sm font-medium text-gris-700 hover:bg-gris-50 disabled:opacity-50"
                >
                  {accionando ? 'Procesando…' : 'Finalizar'}
                </button>
              )}

              {/* Eliminar — siempre disponible */}
              <button
                onClick={manejarEliminar}
                disabled={accionando}
                className="w-full rounded-lg border border-rojo-200 bg-rojo-50 px-4 py-2.5 text-sm font-medium text-rojo-700 hover:bg-rojo-100 disabled:opacity-50"
              >
                {accionando ? 'Procesando…' : 'Eliminar turno'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}