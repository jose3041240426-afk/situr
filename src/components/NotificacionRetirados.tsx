/*
 * Notificación de que el titular se retiró (RF-033).
 *
 * POR QUÉ NO ES UNA TARJETA
 * Antes esto era una tarjeta en mitad de la página con el título, el trámite
 * y la consideración entera del ciudadano. Pero es un suceso ocasional: casi
 * todas las jornadas no hay ninguno, y cuando lo hay el operador solo
 * necesita saber que ese turno no se va a llamar. Una tarjeta permanente
 * ocupaba sitio todo el día para un dato de un segundo, y su texto largo
 * (una opinión escrita por el ciudadano) acababa presidiendo la consola.
 *
 * QUÉ SE CONVIERTE
 * En la misma notificación flotante que ya usa el lote emitido: abajo a la
 * derecha, fuera del flujo de la página, con los códigos y nada más. Se
 * cierra sola a los 15 segundos, o a mano con la X o con Escape.
 *
 * DÓNDE QUEDA LA CONSTANCIA
 * En el historial: el turno cancelado está ahí con su motivo y su
 * consideración. La consola avisa; el historial es el que guarda.
 */
import { useEffect } from 'react'

type Retirado = {
  turno_id: string
  codigo_turno: string
  denominacion_tramite: string
}

type Props = {
  /** Los turnos que el titular retiró en este periodo. */
  retirados: Retirado[]
  /** Cierra la notificación. */
  onCerrar: () => void
}

/** Cuántos segundos se queda en pantalla antes de irse sola. */
const SEGUNDOS = 8

export default function NotificacionRetirados({ retirados, onCerrar }: Props) {
  /*
   * El cierre automático no impide el manual: el temporizador se cancela al
   * desmontar, así que cerrar con la X o con Escape no deja un `onCerrar`
   * pendiente disparándose sobre un componente que ya no está.
   */
  useEffect(() => {
    const temporizador = window.setTimeout(onCerrar, SEGUNDOS * 1000)
    return () => window.clearTimeout(temporizador)
  }, [onCerrar])

  useEffect(() => {
    function alPulsar(e: KeyboardEvent) {
      if (e.key === 'Escape') onCerrar()
    }
    window.addEventListener('keydown', alPulsar)
    return () => window.removeEventListener('keydown', alPulsar)
  }, [onCerrar])

  const total = retirados.length
  const detalle = retirados
    .slice(0, 3)
    .map((r) => `${r.codigo_turno} · ${r.denominacion_tramite}`)
    .join(' · ')
  const resto = total - Math.min(total, 3)

  return (
    <div
      className="notificacion notificacion--aviso"
      role="status"
      aria-live="polite"
    >
      <div className="notificacion-icono" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      </div>

      <div className="min-w-0 flex-1">
        <p className="notificacion-titulo">
          {total === 1
            ? 'Un ciudadano se retiró'
            : `${total} ciudadanos se retiraron`}
        </p>
        <p className="notificacion-detalle">
          {detalle}
          {resto > 0 ? ` y ${resto} más` : ''} · no se{' '}
          {total === 1 ? 'llamará' : 'llamarán'}
        </p>
      </div>

      <button
        type="button"
        onClick={onCerrar}
        className="notificacion-cerrar"
        aria-label="Cerrar la notificación"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}
