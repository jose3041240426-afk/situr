import { useCallback, useEffect, useState } from 'react'
import { Aviso, EsqueletoTabla, Vacio } from '../components/ui'
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
    <>
      {aviso && (
        <div className="mb-4">
          <Aviso tono="peligro">{aviso}</Aviso>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tarjeta titulo="Generados" valor={totales.generados} />
        <Tarjeta titulo="Atendidos" valor={totales.atendidos} tono="azul" />
        <Tarjeta titulo="Cancelados" valor={totales.cancelados} tono="peligro" />
        {/*
          Omitidos en el negro del texto, no en ámbar: omitir es una salida
          normal de la jornada (el ciudadano no se presentó), no una alarma
          que haya que mirar. El ámbar se queda para lo que pide atención.
        */}
        <Tarjeta titulo="Omitidos" valor={totales.omitidos} />
      </div>

      <section className="tarjeta overflow-hidden">
        <div className="border-b border-gris-100 px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
            Por trámite
          </h2>
        </div>
        {cargando ? (
          <EsqueletoTabla columnas={4} filas={6} />
        ) : filas.length === 0 ? (
          <Vacio titulo="Todavía no hay datos" detalle="Las cifras aparecen al cerrar la jornada." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gris-50 text-left text-xs text-gris-700">
                <tr>
                  <th className="px-3 py-2 font-medium">Trámite</th>
                  <th className="px-3 py-2 font-medium">Generados</th>
                  <th className="px-3 py-2 font-medium">Atendidos</th>
                  <th className="px-3 py-2 font-medium">Cancelados</th>
                  <th className="px-3 py-2 font-medium">Omitidos</th>
                  <th className="px-3 py-2 font-medium">Tiempo prom.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gris-100">
                {filas.map((f) => (
                  <tr key={f.clave_tramite} className="hover:bg-gris-50">
                    <td className="px-4 py-2.5">
                      <span className="font-semibold text-navy-800">
                        {f.denominacion_tramite}
                      </span>
                      <br />
                      <span className="font-mono text-xs text-gris-500">
                        {f.clave_tramite}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">{f.generados ?? 0}</td>
                    <td className="px-4 py-2.5 text-azul-600">{f.atendidos ?? 0}</td>
                    <td className="px-4 py-2.5 text-rojo-600">{f.cancelados ?? 0}</td>
                    <td className="px-4 py-2.5 text-navy-900">{f.omitidos ?? 0}</td>
                    <td className="px-4 py-2.5 text-gris-700">
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
    </>
  )
}

function Tarjeta({ titulo, valor, tono = 'neutro' }: {
  titulo: string
  valor: number
  tono?: 'neutro' | 'ok' | 'alerta' | 'peligro' | 'azul'
}) {
  const colores = {
    neutro: 'text-navy-900',
    ok: 'text-verde-600',
    alerta: 'text-ambar-600',
    peligro: 'text-rojo-600',
    /* Atendidos: azul, el color de la acción y de lo que el sistema produce. */
    azul: 'text-azul-600',
  }

  /*
   * Mismo estilo de tarjeta que las cifras de la consola (clases .cifra del
   * index.css): marco de 9 px, radio de 35 px, sombra triple y el velo de
   * grano. Se reutiliza la clase en vez de repetir el CSS, para que las dos
   * pantallas no se separen con el tiempo.
   *
   * El velo aquí es siempre el gris: estas tarjetas no tienen una variante
   * destacada, y las cifras de color (azul, rojo) van sobre blanco para
   * conservar el contraste. «Omitidos» va en el negro del texto: no es una
   * alarma.
   */
  return (
    <div
      className="cifra"
      style={
        { '--cifra-fondo': '#eef3f9', '--cifra-grano': '#a8b7c9' } as React.CSSProperties
      }
    >
      <div className="cifra-velo" />
      <div className="cifra-cuerpo bg-white">
        <p className="text-xs font-semibold uppercase tracking-wide text-gris-700">
          {titulo}
        </p>
        <p className={`mt-1 text-3xl font-black ${colores[tono]}`}>{valor}</p>
      </div>
    </div>
  )
}
