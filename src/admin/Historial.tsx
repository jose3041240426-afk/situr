import { useCallback, useEffect, useState } from 'react'
import Disposicion from './Disposicion'
import { Aviso, ChipEstado, Vacio } from '../components/ui'
import CodigoQR from '../components/CodigoQR'
import { ErrorSitur, formatearFechaHora, listarHistorial, reponerTurno } from '../lib/rpc'
import type { FilaHistorial, RespuestaReposicion } from '../lib/tipos'

/**
 * SITUR — Historial (RF-021).
 *
 * Cada transición de estado deja una fila aquí: estado anterior, estado nuevo,
 * quién, en qué módulo, por qué motivo y cuándo. Es la traza que el DRS llama
 * "coherencia de la traza" y la que un asesor puede pedir.
 *
 * Y es también donde vive el **carril de recurso** (P12): el mensaje que ve
 * el ciudadano cuando su turno se omite le promete "acuda a ventanilla para
 * reposicion". Aquí está la herramienta que cumple esa promesa: emitir un
 * turno nuevo para ese ciudadano, sin omitir a nadie más.
 */
export default function Historial() {
  const [filas, setFilas] = useState<FilaHistorial[]>([])
  const [cargando, setCargando] = useState(true)
  const [filtro, setFiltro] = useState('')
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reponiendo, setReponiendo] = useState<string | null>(null)
  /** El turno repuesto, con su QR: sin esto, la reposición no cierra el
   *  círculo, porque el ciudadano necesita un código nuevo. */
  const [reposicion, setReposicion] = useState<RespuestaReposicion | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const f = await listarHistorial(filtro.trim() || undefined)
      setFilas(f)
      setAviso(null)
    } catch (e) {
      setError(e instanceof ErrorSitur ? e.message : 'No se pudo cargar el historial.')
    } finally {
      setCargando(false)
    }
  }, [filtro])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function reponer(turnoId: string) {
    setReponiendo(turnoId)
    setError(null)
    try {
      const r = await reponerTurno(turnoId)
      // El aviso va DESPUÉS de recargar: `cargar()` limpia el aviso, y aquí
      // lo que se comunica es precisamente el QR que hay que reimprimir.
      await cargar()
      setReposicion(r)
      setAviso(
        `Reposición emitida: ${r.codigo_turno} (en lugar de ${r.codigo_origen}). ` +
          `Imprima el QR nuevo para el ciudadano.`,
      )
    } catch (e) {
      setError(e instanceof ErrorSitur ? e.message : 'No se pudo reponer el turno.')
    } finally {
      setReponiendo(null)
    }
  }

  /**
   * Turnos con una transición a estado terminal reclamable, sin repetir.
   * El historial viene ordenado por fecha DESC, así que la primera fila de
   * cada turno es su estado más reciente: el botón va solo ahí, para no
   * ofrecer la misma acción cinco veces.
   */
  const reclamables = new Map<string, FilaHistorial>()
  for (const f of filas) {
    if (!reclamables.has(f.turno_id)) {
      reclamables.set(f.turno_id, f)
    }
  }

  return (
    <Disposicion titulo="Historial">
      {aviso && (
        <div className="mb-4">
          <Aviso tono="ok">{aviso}</Aviso>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Aviso tono="peligro">{error}</Aviso>
        </div>
      )}

      {/*
        El QR del turno repuesto. Sin esto, la reposición se queda a medias:
        el ciudadano necesita un código NUEVO, y el operador tiene que poder
        dárselo en el momento.
      */}
      {reposicion && (
        <section className="tarjeta impresion-boleto mb-4 p-4">
          <div className="impresion-boleto-fila flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-institucional-400">
                Reposición emitida
              </p>
              <p className="mt-1 text-3xl font-black text-institucional-800">
                {reposicion.codigo_turno}
              </p>
              <p className="mt-1 text-sm text-institucional-500">
                {reposicion.denominacion_tramite} · en lugar de{' '}
                {reposicion.codigo_origen}
              </p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <CodigoQR valor={`${window.location.origin}/turno/${reposicion.token_publico}`} />
              <p className="max-w-[15rem] text-center text-[10px] leading-relaxed text-institucional-400">
                Este código es la credencial de su turno: no lo comparta ni
                lo muestre en público.
              </p>
              <div className="no-imprimir flex gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="boton-secundario px-3 py-1.5 text-xs"
                >
                  Imprimir
                </button>
                <a
                  href={`/turno/${reposicion.token_publico}`}
                  target="_blank"
                  rel="noreferrer"
                  className="boton-secundario px-3 py-1.5 text-xs"
                >
                  Ver
                </a>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="tarjeta overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-institucional-100 px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
            Transiciones registradas
          </h2>
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            <input
              className="campo w-full py-1.5 text-sm sm:w-64"
              placeholder="Filtrar por folio (A-001)"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void cargar()
              }}
            />
            <button type="button" onClick={() => void cargar()} className="boton-secundario shrink-0 py-1.5 text-xs">
              Buscar
            </button>
          </div>
        </div>

        {cargando ? (
          <Vacio titulo="Cargando…" />
        ) : filas.length === 0 ? (
          <Vacio
            titulo="Sin transiciones que mostrar"
            detalle="Cada llamada, omisión, atención y cierre queda registrada aquí."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-institucional-50 text-left text-xs text-institucional-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Fecha</th>
                  <th className="px-3 py-2 font-medium">Turno</th>
                  <th className="px-3 py-2 font-medium">Cambio</th>
                  <th className="px-3 py-2 font-medium">Operador</th>
                  <th className="px-3 py-2 font-medium">Módulo</th>
                  <th className="px-3 py-2 font-medium">Motivo</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-institucional-100">
                {filas.map((f) => (
                  <tr key={`${f.turno_id}-${f.fecha}`} className="hover:bg-institucional-50">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-institucional-500">
                      {formatearFechaHora(f.fecha)}
                    </td>
                    <td className="px-4 py-2.5 font-bold text-institucional-800">
                      {f.codigo_turno}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {f.estado_anterior && <ChipEstado estado={f.estado_anterior} />}
                        <span className="text-institucional-300">→</span>
                        <ChipEstado estado={f.estado_nuevo} />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-institucional-600">
                      {f.nombre_usuario ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-institucional-600">
                      {f.codigo_modulo ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-institucional-500">
                      {f.motivo ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {/*
                        El carril de recurso (P12). El mensaje del ciudadano
                        dice "acuda a ventanilla para reposicion": aquí está
                        lo que hace falta para cumplirlo. Solo en la fila
                        más reciente de cada turno.
                      */}
                      {reclamables.get(f.turno_id) === f &&
                      (f.estado_actual === 'SKIPPED' || f.estado_actual === 'CANCELLED') ? (
                        <button
                          type="button"
                          onClick={() => void reponer(f.turno_id)}
                          disabled={reponiendo !== null}
                          className="boton-secundario px-3 py-1.5 text-xs"
                        >
                          {reponiendo === f.turno_id ? 'Reponiendo…' : 'Reponer'}
                        </button>
                      ) : null}
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
