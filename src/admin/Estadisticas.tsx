import { useCallback, useEffect, useState } from 'react'
import Disposicion from './Disposicion'
import { Aviso, Vacio } from '../components/ui'
import { ErrorSitur, listarEstadisticas } from '../lib/rpc'
import type { FilaEstadistica } from '../lib/tipos'

/**
 * SITUR — Estadísticas (RF-022).
 *
 * Lo que el DRS promete: generados, atendidos, cancelados, omitidos y tiempos
 * promedio, por trámite.
 */
export default function Estadisticas() {
  const [filas, setFilas] = useState<FilaEstadistica[]>([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    try {
      setFilas(await listarEstadisticas())
      setAviso(null)
    } catch (e) {
      setAviso(e instanceof ErrorSitur ? e.message : 'No se pudieron cargar las estadísticas.')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  const totales = filas.reduce(
    (acc, f) => ({
      generados: acc.generados + (f.generados ?? 0),
      atendidos: acc.atendidos + (f.atendidos ?? 0),
      cancelados: acc.cancelados + (f.cancelados ?? 0),
      omitidos: acc.omitidos + (f.omitidos ?? 0),
    }),
    { generados: 0, atendidos: 0, cancelados: 0, omitidos: 0 },
  )

  return (
    <Disposicion titulo="Estadísticas">
      {aviso && (
        <div className="mb-4">
          <Aviso tono="peligro">{aviso}</Aviso>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tarjeta titulo="Generados" valor={totales.generados} />
        <Tarjeta titulo="Atendidos" valor={totales.atendidos} tono="ok" />
        <Tarjeta titulo="Cancelados" valor={totales.cancelados} tono="peligro" />
        <Tarjeta titulo="Omitidos" valor={totales.omitidos} tono="alerta" />
      </div>

      <section className="tarjeta overflow-hidden">
        <div className="border-b border-institucional-100 px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
            Por trámite
          </h2>
        </div>
        {cargando ? (
          <Vacio titulo="Cargando…" />
        ) : filas.length === 0 ? (
          <Vacio titulo="Todavía no hay datos" detalle="Las cifras aparecen al cerrar la jornada." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-institucional-50 text-left text-xs text-institucional-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Trámite</th>
                  <th className="px-3 py-2 font-medium">Generados</th>
                  <th className="px-3 py-2 font-medium">Atendidos</th>
                  <th className="px-3 py-2 font-medium">Cancelados</th>
                  <th className="px-3 py-2 font-medium">Omitidos</th>
                  <th className="px-3 py-2 font-medium">Tiempo prom.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-institucional-100">
                {filas.map((f) => (
                  <tr key={f.clave_tramite} className="hover:bg-institucional-50">
                    <td className="px-4 py-2.5">
                      <span className="font-semibold text-institucional-800">
                        {f.denominacion_tramite}
                      </span>
                      <br />
                      <span className="font-mono text-xs text-institucional-400">
                        {f.clave_tramite}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">{f.generados ?? 0}</td>
                    <td className="px-4 py-2.5 text-ok-700">{f.atendidos ?? 0}</td>
                    <td className="px-4 py-2.5 text-peligro-700">{f.cancelados ?? 0}</td>
                    <td className="px-4 py-2.5 text-alerta-700">{f.omitidos ?? 0}</td>
                    <td className="px-4 py-2.5 text-institucional-500">
                      {f.tiempo_promedio_atencion != null
                        ? `${Math.round(f.tiempo_promedio_atencion)} min`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Disposicion>
  )
}

function Tarjeta({ titulo, valor, tono = 'neutro' }: {
  titulo: string
  valor: number
  tono?: 'neutro' | 'ok' | 'alerta' | 'peligro'
}) {
  const colores = {
    neutro: 'text-institucional-800',
    ok: 'text-ok-700',
    alerta: 'text-alerta-700',
    peligro: 'text-peligro-700',
  }
  return (
    <div className="tarjeta p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-institucional-400">
        {titulo}
      </p>
      <p className={`mt-1 text-3xl font-black ${colores[tono]}`}>{valor}</p>
    </div>
  )
}
