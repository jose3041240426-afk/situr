/*
 * Botón «Llamar» con icono que despega al pasar el cursor.
 *
 * PORTADO DEL DISEÑO, NO PEGADO
 *
 * El original venía con `styled-components`. Este proyecto no los usa: el
 * estilo vive en Tailwind y en dos clases nuevas de `index.css`. Portarlo
 * costaba menos que meter una librería de CSS-en-JS solo para un botón, y
 * además `styled-components` en React 19 exige configuración extra.
 *
 * QUÉ SE CONSERVA DEL ORIGINAL
 *
 *   - El icono despega hacia la derecha, gira 45° y crece un 10 %.
 *   - El texto se desplaza a la derecha dejando el hueco del icono.
 *   - El icono flota (`fly-1`) mientras el cursor está encima.
 *   - Al pulsar, el botón se encoge un 5 %.
 *
 * QUÉ CAMBIA
 *
 *   1. El ICONO. El original traía un avión de papel en SVG. Aquí se usa el
 *      megáfono que pediste, como máscara CSS (`.bi--megaphone-fill`): es un
 *      `div` con `mask-image`, así toma el color del texto y no hay que
 *      duplicar el SVG por cada variante de color.
 *   2. El COLOR. `royalblue` no es un token del sistema y su contraste con
 *      blanco es 4.67:1, apenas por encima del mínimo. Se usa el azul del
 *      sistema, que con texto blanco da 7.4:1.
 *   3. Los TAMAÑOS. El original era de 20 px de fuente y `0.7em` de relleno;
 *      eso es enorme para una barra de acciones dentro de una tarjeta. Se baja
 *      a 15 px sin tocar la mecánica de la animación.
 *   4. ACCESIBILIDAD. `:focus-visible` con anillo real, y la animación se
 *      apaga con `prefers-reduced-motion`: movimiento infinito junto al cursor
 *      es justo lo que esa preferencia pide desactivar.
 */
import type { ButtonHTMLAttributes } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Texto del botón. Por defecto, «Llamar». */
  children?: React.ReactNode
}

export default function BotonLlamar({
  children = 'Llamar',
  className = '',
  ...resto
}: Props) {
  return (
    <button type="button" className={`boton-llamar ${className}`} {...resto}>
      <span className="boton-llamar-envoltura">
        <span className="boton-llamar-icono bi--megaphone-fill" aria-hidden="true" />
      </span>
      <span className="boton-llamar-texto">{children}</span>
    </button>
  )
}
