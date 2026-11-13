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
                  <button
                    key={t.turno_id}
                    type="button"
                    onClick={() => {
                      setModalTurno(t)
                      setModalVentanilla(v)
                      setTimerSegundos(0)
                      setTimerActivo(false)
                    }}
                    className="turno-entrada w-full text-left rounded-xl bg-gris-50 p-3 cursor-pointer hover:bg-gris-100 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xl font-bold text-gris-900">{t.turno_codigo}</div>
                        {t.turno_denominacion_tramite && (
                          <div className="text-xs text-gris-600">{t.turno_denominacion_tramite}</div>
                        )}
                      </div>
                    </div>
                  </button>
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

      {/* Modal de opciones del turno — información completa */}
      {modalTurno && modalVentanilla && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 modal-bg-entrada">
          <div className="tarjeta w-full max-w-lg p-0 modal-entrada overflow-hidden">

            {/* Header del modal */}
            <div className="flex items-center justify-between border-b border-gris-200 px-5 py-4 bg-gris-50">
              <div>
                <h3 className="text-lg font-bold text-gris-900">
                  {modalTurno.turno_codigo}
                </h3>
                <p className="text-xs text-gris-500">
                  Ventanilla {modalVentanilla.codigo}
                </p>
              </div>
              <button
                onClick={cerrarModal}
                className="rounded-lg p-1 text-gris-400 hover:bg-gris-200 hover:text-gris-600 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24">
                  <path d="M0 0h24v24H0z" fill="none" />
                  <path fill="currentColor" d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4z" />
                </svg>
              </button>
            </div>

            {/* Cuerpo con datos del turno */}
            <div className="px-5 py-4 space-y-4">

              {/* Trámite y prioridad */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-gris-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="1.1em" height="1.1em" viewBox="0 0 24 24">
                    <path d="M0 0h24v24H0z" fill="none"/>
                    <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V9zM6 20V7h5v6h6v7z"/>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gris-900">
                    {modalTurno.turno_denominacion_tramite || 'Sin trámite'}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {modalTurno.turno_clave_tramite && (
                      <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {modalTurno.turno_clave_tramite}
                      </span>
                    )}
                    {modalTurno.turno_folio != null && (
                      <span className="text-xs text-gris-500">Folio {modalTurno.turno_folio}</span>
                    )}
                    {modalTurno.turno_prioridad && modalTurno.turno_prioridad !== 'NORMAL' && (
                      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                        modalTurno.turno_prioridad === 'URGENTE'
                          ? 'bg-rojo-100 text-rojo-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        {modalTurno.turno_prioridad === 'URGENTE' ? 'Urgente' : 'Preferente'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Estado */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-gris-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="1.1em" height="1.1em" viewBox="0 0 24 24">
                    <path d="M0 0h24v24H0z" fill="none"/>
                    <path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm1-4.5v-5a1 1 0 0 0-2 0v5a1 1 0 0 0 1 1h.5a1 1 0 0 0 0-2z"/>
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-gris-900">Estado</div>
                  <div className="text-sm text-gris-600">
                    {modalTurno.turno_estado === 'ASIGNED' && 'Asignado — esperando llamada'}
                    {modalTurno.turno_estado === 'CALLED' && 'Llamado — esperando atención'}
                    {modalTurno.turno_estado === 'SERVING' && 'En atención'}
                    {modalTurno.turno_estado === 'WAITING' && 'En espera'}
                    {modalTurno.turno_estado === 'COMPLETED' && 'Completado'}
                    {modalTurno.turno_estado === 'CANCELLED' && 'Cancelado'}
                    {modalTurno.turno_estado === 'SKIPPED' && 'Saltado'}
                  </div>
                </div>
              </div>

              {/* Línea de tiempo */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-gris-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="1.1em" height="1.1em" viewBox="0 0 24 24">
                    <path d="M0 0h24v24H0z" fill="none"/>
                    <path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm.5-13h-1v6l4.7 3.2.7-.9-4-2.8z"/>
                  </svg>
                </div>
                <div className="flex-1 space-y-2">
                  {modalTurno.turno_creado_en && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gris-500">Creado</span>
                      <span className="font-medium text-gris-700">
                        {new Date(modalTurno.turno_creado_en).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {' '}
                        {new Date(modalTurno.turno_creado_en).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                  )}
                  {modalTurno.turno_llamado_en && (modalTurno.turno_estado === 'CALLED' || modalTurno.turno_estado === 'SERVING') && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gris-500">Llamado</span>
                      <span className="font-medium text-gris-700">
                        {new Date(modalTurno.turno_llamado_en).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                  )}
                  {modalTurno.turno_inicio_atencion && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gris-500">Inicio atención</span>
                      <span className="font-medium text-gris-700">
                        {new Date(modalTurno.turno_inicio_atencion).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                  )}
                  {!modalTurno.turno_llamado_en && !modalTurno.turno_inicio_atencion && (
                    <div className="text-sm text-gris-400 italic">Sin registros de tiempo aún</div>
                  )}
                </div>
              </div>

              {/* Operador */}
              {modalTurno.operador_nombres && (
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 text-gris-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="1.1em" height="1.1em" viewBox="0 0 24 24">
                      <path d="M0 0h24v24H0z" fill="none"/>
                      <path fill="currentColor" d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5s-5 2.3-5 5s2.3 5 5 5zm0 2c-2.7 0-7 1.3-7 4v1h14v-1c0-2.7-4.3-4-7-4z"/>
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-gris-900">Operador</div>
                    <div className="text-sm text-gris-600">{modalTurno.operador_nombres}</div>
                  </div>
                </div>
              )}

              {/* Timer de aviso */}
              {timerActivo && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
                  <div className="text-xs text-amber-600">Aviso al siguiente en</div>
                  <div className="text-2xl font-bold text-amber-700 font-mono">
                    {formatoTiempo(timerSegundos)}
                  </div>
                </div>
              )}
            </div>

            {/* Acciones */}
            <div className="border-t border-gris-200 bg-gris-50 px-5 py-4 flex items-center justify-between gap-2">
              {/* Izquierda: Llamar (ASIGNED) o Iniciar atención (CALLED) */}
              <div className="flex-1">
                {modalTurno.turno_estado === 'ASIGNED' && (
                  <button
                    onClick={manejarLlamar}
                    disabled={accionando}
                    className="boton-primario w-full"
                  >
                    {accionando ? 'Procesando…' : 'Llamar turno'}
                  </button>
                )}
                {modalTurno.turno_estado === 'CALLED' && (
                  <button
                    onClick={manejarIniciarAtencion}
                    disabled={accionando}
                    className="boton-primario w-full"
                  >
                    {accionando ? 'Procesando…' : 'Iniciar atención'}
                  </button>
                )}
              </div>

              {/* Derecha: Finalizar (CALLED/SERVING) y Eliminar (siempre) */}
              <div className="flex flex-col gap-2">
                {(modalTurno.turno_estado === 'CALLED' || modalTurno.turno_estado === 'SERVING') && (
                  <button
                    onClick={manejarFinalizar}
                    disabled={accionando}
                    className="rounded-lg border border-gris-300 bg-white px-4 py-2.5 text-sm font-medium text-gris-700 hover:bg-gris-50 disabled:opacity-50"
                  >
                    {accionando ? 'Procesando…' : 'Finalizar'}
                  </button>
                )}
                <button
                  onClick={manejarEliminar}
                  disabled={accionando}
                  className="rounded-lg border border-rojo-200 bg-rojo-50 px-4 py-2.5 text-sm font-medium text-rojo-700 hover:bg-rojo-100 disabled:opacity-50"
                >
                  {accionando ? 'Procesando…' : 'Eliminar turno'}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  )
}