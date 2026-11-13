import { useCallback, useEffect, useState } from 'react'
import { estadoVentanillas, solicitarTurnoVentanilla } from '../lib/rpc'
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
                  <div key={t.turno_id} className="rounded-xl bg-gris-50 p-3">
                    <div className="text-xl font-bold text-gris-900">{t.turno_codigo}</div>
                    {t.turno_denominacion_tramite && (
                      <div className="text-xs text-gris-600">{t.turno_denominacion_tramite}</div>
                    )}
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

    </div>
  )
}