import { useCallback, useEffect, useMemo, useState } from 'react'
import Disposicion from './Disposicion'
import { Aviso, ChipEstado, Vacio } from '../components/ui'
import CodigoQR from '../components/CodigoQR'
import { ErrorSitur, formatearFechaHora, listarHistorial, reponerTurno } from '../lib/rpc'
import { ETIQUETA_ESTADO } from '../lib/tipos'
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

  /*
    AGRUPAR POR TURNO.

    La vista es una línea de tiempo POR TURNO (como en la referencia de
    diseño), no una tabla plana de transiciones: lo que el operador quiere
    ver es «qué le pasó a este turno», con su recorrido completo —generado,
    llamado, en atención, finalizado— y no 400 filas mezcladas.

    Se agrupan las transiciones conservando el orden en que llegaron (la
    vista viene ordenada por fecha) y se mantiene la más reciente de cada
    turno, que es la que lleva el botón de reponer.
  */
  const porTurno = useMemo(() => {
    const grupos = new Map<string, FilaHistorial[]>()
    for (const f of filas) {
      const lista = grupos.get(f.turno_id)
      if (lista) lista.push(f)
      else grupos.set(f.turno_id, [f])
    }
    return [...grupos.values()]
  }, [filas])

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
              <p className="text-xs font-semibold uppercase tracking-wide text-gris-500">
                Reposición emitida
              </p>
              <p className="mt-1 text-3xl font-black text-navy-800">
                {reposicion.codigo_turno}
              </p>
              <p className="mt-1 text-sm text-gris-700">
                {reposicion.denominacion_tramite} · en lugar de{' '}
                {reposicion.codigo_origen}
              </p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <CodigoQR valor={`${window.location.origin}/turno/${reposicion.token_publico}`} />
              <p className="max-w-[15rem] text-center text-[10px] leading-relaxed text-gris-500">
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
        <div className="flex flex-wrap items-center gap-3 border-b border-gris-100 px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
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
          <div className="space-y-4">
            {porTurno.map((transiciones) => {
              const primera = transiciones[0]
              const ultima = transiciones[transiciones.length - 1]
              const reponerTurno =
                reclamables.get(ultima.turno_id) === ultima &&
                (ultima.estado_actual === 'SKIPPED' ||
                  ultima.estado_actual === 'CANCELLED')
              return (
                <section key={primera.turno_id} className="tarjeta overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gris-100 px-5 py-3.5">
                    <div className="flex items-baseline gap-3">
                      <span className="text-xl font-black tracking-tight text-navy-800">
                        {primera.codigo_turno}
                      </span>
                      <ChipEstado estado={ultima.estado_actual} />
                    </div>
                    {reponerTurno && (
                      <button
                        type="button"
                        onClick={() => void reponer(ultima.turno_id)}
                        disabled={reponiendo !== null}
                        className="boton-secundario px-3 py-1.5 text-xs"
                      >
                        {reponiendo === ultima.turno_id ? 'Reponiendo…' : 'Reponer'}
                      </button>
                    )}
                  </div>

                  <ol className="relative px-5 py-4">
                    {/*
                      La línea vertical que une los hitos, en una columna
                      propia para que no dependa de los iconos.
                    */}
                    <span
                      aria-hidden="true"
                      className="absolute bottom-8 left-[2.05rem] top-8 w-0.5 rounded bg-gris-200"
                    />
                    {transiciones.map((f) => (
                      <li key={`${f.turno_id}-${f.fecha}`} className="relative flex gap-4 py-3">
                        <span
                          className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                            f.estado_nuevo === 'COMPLETED'
                              ? 'bg-verde-500 text-white'
                              : f.estado_nuevo === 'CANCELLED' || f.estado_nuevo === 'SKIPPED'
                                ? 'bg-rojo-500 text-white'
                                : 'bg-azul-500 text-white'
                          }`}
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-navy-800">
                            {f.estado_anterior
                              ? `${ETIQUETA_ESTADO[f.estado_anterior]} → ${ETIQUETA_ESTADO[f.estado_nuevo]}`
                              : `Turno generado (${ETIQUETA_ESTADO[f.estado_nuevo]})`}
                          </p>
                          <p className="text-xs text-gris-500">
                            {formatearFechaHora(f.fecha)}
                            {f.nombre_usuario ? ` · ${f.nombre_usuario}` : ''}
                            {f.codigo_modulo ? ` · módulo ${f.codigo_modulo}` : ''}
                          </p>
                          {f.motivo && (
                            <p className="mt-1 text-xs text-gris-700">«{f.motivo}»</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )
            })}
          </div>
        )}
      </section>
    </Disposicion>
  )
}
