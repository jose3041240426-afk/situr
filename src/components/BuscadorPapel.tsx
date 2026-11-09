/**
 * Buscador de papel (recepción).
 *
 * PROBLEMA QUE RESUELVE
 * Al emitir por lotes salen decenas de papeles iguales y sin dueño. Cuando
 * alguien llega con uno en la mano hay que saber rápido si ese papel todavía
 * vale o si ya lo tomó otra persona.
 *
 * SE BUSCA POR CÓDIGO, NO POR FOLIO
 * El folio NO es único: cada trámite lleva su propio contador, así que «folio
 * 1» existe varias veces el mismo día. El código (`C-184`) sí es único y es el
 * mismo que va en el QR. Por eso el campo dice «Código» y no «Folio».
 *
 * NO GUARDA NADA
 * La respuesta sale del estado del turno (`WAITING` = libre). No hay una marca
 * que alguien pueda olvidar poner, así que no puede quedar desactualizada.
 */
import { useState } from 'react'
import { consultarTurnoPorCodigo, type ConsultaTurno } from '../lib/rpc'
import { ErrorSitur } from '../lib/rpc'
import MarcaDisponible from './MarcaDisponible'

export default function BuscadorPapel() {
  const [codigo, setCodigo] = useState('')
  const [resultado, setResultado] = useState<ConsultaTurno | null>(null)
  const [buscado, setBuscado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [buscando, setBuscando] = useState(false)

  async function buscar(e: React.FormEvent) {
    e.preventDefault()
    const limpio = codigo.trim()
    if (!limpio) return

    setBuscando(true)
    setError(null)
    try {
      setResultado(await consultarTurnoPorCodigo(limpio))
      setBuscado(true)
    } catch (err) {
      setError(err instanceof ErrorSitur ? err.message : 'No se pudo consultar el turno.')
      setResultado(null)
    } finally {
      setBuscando(false)
    }
  }

  return (
    <form onSubmit={buscar} className="space-y-3">
      <div className="flex gap-2">
        <label htmlFor="buscar-papel" className="sr-only">
          Código del turno impreso en el papel
        </label>
        <input
          id="buscar-papel"
          /*
           * `.campo` y no `.selector`: `.selector` dibuja la flecha del
           * desplegable, y este es un campo de texto donde se teclea un
           * código. Con la flecha parecía un desplegable que no abre.
           */
          className="campo flex-1"
          placeholder="C-184"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          /* Sin autocompletado: es una consulta, no un dato del usuario, y el
             navegador ofrecería códigos viejos que ya no sirven. */
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={buscando || !codigo.trim()}
          className="boton-secundario whitespace-nowrap"
        >
          {buscando ? 'Buscando…' : 'Consultar'}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs font-semibold text-rojo-600">
          {error}
        </p>
      )}

      {/*
        `aria-live="polite"` para que el lector de pantalla anuncie el
        resultado sin robar el foco del campo, que se queda listo para la
        siguiente consulta.
      */}
      <div aria-live="polite">
        {buscado && !resultado && !error && (
          <p className="rounded-lg bg-gris-50 px-3 py-2 text-xs text-gris-700">
            No hay ningún turno con ese código en el periodo actual.
          </p>
        )}

        {resultado && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gris-50 px-3 py-2">
            <div className="min-w-0">
              <p className="font-bold text-navy-800">{resultado.codigo_turno}</p>
              <p className="text-xs text-gris-700">
                {resultado.denominacion_tramite}
                {resultado.tiene_dueno && resultado.nombre_trabajador
                  ? ` · lo atiende ${resultado.nombre_trabajador}`
                  : ''}
              </p>
            </div>
            <MarcaDisponible conDueno={resultado.tiene_dueno} quien={resultado.nombre_trabajador} />
          </div>
        )}
      </div>
    </form>
  )
}
