/*
 * Notificación flotante (toast).
 *
 * POR QUÉ EXISTE
 * El resumen del lote emitido ocupaba una tarjeta entera en la columna
 * izquierda, con su título, el total y una fila de folios. Era demasiado peso
 * para algo que se consulta una vez y se descarta: al emitir, lo único que el
 * operador necesita saber es «salió bien, fueron N turnos», y como mucho los
 * folios para dictarlos.
 *
 * QUÉ DECISIÓN TOMA
 * La información sigue disponible (total + folios), pero en una notificación
 * que no ocupa sitio en el flujo de la página y se va sola. El contenedor
 * permanente desaparece.
 *
 * POR QUÉ SE CIERRA SOLA A LOS 8 SEGUNDOS
 * Antes se quedaba hasta que alguien la cerrara. En una ventanilla eso es una
 * tarjeta más en pantalla: el operador emite, sigue trabajando y la
 * notificación acaba tapando la cola. Ocho segundos son de sobra para leer dos
 * líneas y copiar unos folios; si no llega, la misma información está en el
 * boleto y en el historial. También se puede cerrar antes con la X o Escape.
 */
import { useEffect, useRef } from 'react'

/** Cuántos segundos se queda en pantalla antes de irse sola. */
const SEGUNDOS = 8

type Props = {
  /** Cuántos turnos se emitieron. */
  total: number
  /** Folios emitidos, en orden. */
  codigos: string[]
  /** Cierra la notificación. */
  onCerrar: () => void
}

export default function NotificacionLote({ total, codigos, onCerrar }: Props) {
  const cerrar = useRef<HTMLButtonElement>(null)

  /*
   * Escape la cierra.
   *
   * El `keydown` va en `window` y no en el contenedor porque la notificación
   * no recibe el foco al aparecer: el usuario está en el botón de emitir, y
   * exigirle que tabule hasta aquí para cerrarla sería peor que no ofrecer el
   * atajo.
   */
  useEffect(() => {
    function alPulsar(e: KeyboardEvent) {
      if (e.key === 'Escape') onCerrar()
    }
    window.addEventListener('keydown', alPulsar)
    return () => window.removeEventListener('keydown', alPulsar)
  }, [onCerrar])

  /*
   * El cierre automático se cancela al desmontar, así que cerrar a mano no
   * deja un `onCerrar` pendiente disparándose sobre un componente que ya no
   * está.
   */
  useEffect(() => {
    const temporizador = window.setTimeout(onCerrar, SEGUNDOS * 1000)
    return () => window.clearTimeout(temporizador)
  }, [onCerrar])

  return (
    <div
      className="notificacion"
      /*
       * `role="status"` y `aria-live="polite"`: se anuncia al lector de
       * pantalla sin interrumpir lo que esté diciendo. `alert` sería
       * demasiado agresivo para una confirmación.
       */
      role="status"
      aria-live="polite"
    >
      <div className="notificacion-icono" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>

      <div className="min-w-0 flex-1">
        <p className="notificacion-titulo">
          {total === 1 ? 'Turno emitido' : `${total} turnos emitidos`}
        </p>
        {/*
          Los folios se muestran en línea, cortados a las dos líneas. Si son
          muchos, el total ya está arriba y el detalle sobra: ver 200 códigos
          apilados taparía la pantalla.
        */}
        <p className="notificacion-detalle">{codigos.join(' · ')}</p>
      </div>

      <button
        ref={cerrar}
        type="button"
        onClick={onCerrar}
        className="notificacion-cerrar"
        aria-label="Cerrar la notificación"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}
