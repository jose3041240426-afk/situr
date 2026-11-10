import { useCallback, useEffect, useState } from 'react'
import { Aviso, ChipEstado, Esqueleto, Vacio } from '../components/ui'
import CodigoQR from '../components/CodigoQR'
import Paginador from '../components/Paginador'
import {
  ErrorSitur,
  formatearFechaHora,
  listarHistorialPaginado,
  reponerTurno,
  type TurnoHistorialPaginado,
} from '../lib/rpc'
import { ETIQUETA_ESTADO } from '../lib/tipos'
import type { RespuestaReposicion } from '../lib/tipos'

/**
 * SITUR — Historial (RF-021).
 *
 * Paginado por turno (migración 019): filtra por fecha del periodo y por
 * código, y pagina en el servidor. Con 1000 turnos, el navegador solo
 * mantiene 10 en el DOM.
 *
 * La estructura visual:
 *   · Un contenedor de filtros arriba (fecha + código + botón).
 *   · Un listado de turnos, cada uno en su propia tarjeta.
 *   · Un paginador abajo.
 *
 * Antes había un `<section>` que envolvía la lista, pero como cada turno
 * ya trae su tarjeta, el wrapper solo añadía un marco exterior que no
 * aportaba nada (y ocupaba el espacio del scroll).
 */
const POR_PAGINA = 10

function hoyISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

export default function Historial() {
  const [turnos, setTurnos] = useState<TurnoHistorialPaginado[]>([])
  const [total, setTotal] = useState(0)
  const [pagina, setPagina] = useState(1)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [reponiendo, setReponiendo] = useState<string | null>(null)
  const [reposicion, setReposicion] = useState<RespuestaReposicion | null>(null)

  // Estado de los filtros. `fechaAplicada` es la que se consultó; `fechaInput`
  // es la que está en el input. Al pulsar "Buscar", se copia una a otra.
  const [fechaInput, setFechaInput] = useState(hoyISO)
  const [filtroInput, setFiltroInput] = useState('')
  const [fechaAplicada, setFechaAplicada] = useState(hoyISO)
  const [filtroAplicado, setFiltroAplicado] = useState('')

  const cargar = useCallback(
    async (fecha: string, filtro: string, pag: number) => {
      setCargando(true)
      setError(null)
      try {
        const r = await listarHistorialPaginado(fecha, filtro || undefined, pag, POR_PAGINA)
        setTurnos(r.turnos)
        setTotal(r.total)
      } catch (e) {
        setError(e instanceof ErrorSitur ? e.message : 'No se pudo cargar el historial.')
      } finally {
        setCargando(false)
      }
    },
    [],
  )

  useEffect(() => {
    void cargar(fechaAplicada, filtroAplicado, pagina)
  }, [cargar, fechaAplicada, filtroAplicado, pagina])

  function aplicarFiltros() {
    setPagina(1)
    setFechaAplicada(fechaInput || hoyISO())
    setFiltroAplicado(filtroInput.trim())
  }

  async function reponer(turnoId: string) {
    setReponiendo(turnoId)
    setError(null)
    try {
      const r = await reponerTurno(turnoId)
      await cargar(fechaAplicada, filtroAplicado, pagina)
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

  return (
    <>
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

      {/* ---------------------------------------------------------------
          Contenedor de filtros. Va ARRIBA del primer turno, y con mb-4
          para separarlo del listado. Antes vivía dentro del `<section>`
          "Transiciones registradas", que envolvía toda la lista.
          --------------------------------------------------------------- */}
      <section className="tarjeta mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gris-700">
            Fecha
            <input
              type="date"
              value={fechaInput}
              onChange={(e) => setFechaInput(e.target.value)}
              className="campo py-1.5 text-sm"
              max={hoyISO()}
            />
          </label>

          {/* El grupo código + botón va pegado a la derecha, y el campo es
              corto (w-40 = 160px): solo tiene que caber «A-001». */}
          <div className="ml-auto flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gris-700">
              Código
              <input
                className="campo w-40 py-1.5 text-sm"
                placeholder="A-001"
                value={filtroInput}
                onChange={(e) => setFiltroInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') aplicarFiltros()
                }}
              />
            </label>

            <button
              type="button"
              onClick={aplicarFiltros}
              className="boton-primario boton-pildora px-4 py-2 text-sm"
            >
              Buscar
            </button>
          </div>
        </div>
        {!cargando && (
          <p className="mt-2 text-xs text-gris-500">
            {total === 0
              ? 'Sin turnos para ese filtro.'
              : `${total} ${total === 1 ? 'turno' : 'turnos'} para ${
                  fechaAplicada === hoyISO() ? 'hoy' : fechaAplicada
                }${filtroAplicado ? ` · filtro «${filtroAplicado}»` : ''}.`}
          </p>
        )}
      </section>

      {/* Listado */}
      {cargando ? (
        <div className="mb-4 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="tarjeta p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="esqueleto-bloque h-5 w-24 rounded" />
                <div className="esqueleto-bloque h-5 w-20 rounded-full" />
              </div>
              <Esqueleto filas={3} alto="h-3" />
            </div>
          ))}
        </div>
      ) : turnos.length === 0 ? (
        <div className="tarjeta mb-4">
          <Vacio
            titulo="Sin transiciones que mostrar"
            detalle="Prueba con otra fecha o cambia el filtro."
          />
        </div>
      ) : (
        <div className="mb-4 space-y-4">
          {turnos.map((turno) => {
            const reclamable =
              turno.estado_actual === 'SKIPPED' || turno.estado_actual === 'CANCELLED'
            return (
              <section key={turno.turno_id} className="tarjeta overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gris-100 px-5 py-3.5">
                  <div className="flex min-w-0 items-baseline gap-3">
                    <span className="truncate text-xl font-black tracking-tight text-navy-800">
                      {turno.codigo_turno}
                    </span>
                    <ChipEstado estado={turno.estado_actual} />
                  </div>
                  {reclamable && (
                    <button
                      type="button"
                      onClick={() => void reponer(turno.turno_id)}
                      disabled={reponiendo !== null}
                      className="boton-secundario px-3 py-1.5 text-xs"
                    >
                      {reponiendo === turno.turno_id ? 'Reponiendo…' : 'Reponer'}
                    </button>
                  )}
                </div>

                <ol className="relative px-5 py-4">
                  <span
                    aria-hidden="true"
                    className="absolute bottom-8 left-[2.05rem] top-8 w-0.5 rounded bg-gris-200"
                  />
                  {turno.transiciones.map((f, i) => (
                    <li
                      key={`${turno.turno_id}-${i}-${f.fecha}`}
                      className="relative flex gap-4 py-3"
                    >
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
                          <p className="mt-1 break-words text-xs text-gris-700">
                            «{f.motivo}»
                          </p>
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

      {/*
        Paginador.

        Va dentro de una tarjeta blanca y no suelto sobre el fondo: la página
        entera son tarjetas, y un paginador flotando en el degradado parecía
        parte del fondo y no un control. Además, el «Mostrando 1–10 de 14» es
        texto y necesita un fondo real debajo para que el contraste se pueda
        medir (mismo motivo que el del resto de `.tarjeta`).
      */}
      {total > POR_PAGINA && (
        <div className="tarjeta flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <p className="text-xs text-gris-500" role="status" aria-live="polite">
            Mostrando {(pagina - 1) * POR_PAGINA + 1}–
            {Math.min(pagina * POR_PAGINA, total)} de {total}
          </p>
          <Paginador
            total={total}
            pagina={pagina}
            porPagina={POR_PAGINA}
            onCambiar={setPagina}
          />
        </div>
      )}
    </>
  )
}
