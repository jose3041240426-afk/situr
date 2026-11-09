/*
 * Botón «Emitir turno» con el desplegable del diseño que enviaste.
 *
 * QUÉ HACE
 * En reposo se ve el icono del boleto y el texto. Al pasar el cursor, el
 * icono se estira hasta ocupar todo el botón y el texto se desvanece
 * (`width: 70px → 175px`, que es el ancho completo). Al pulsar, el icono se
 * encoge un 15 %.
 *
 * QUÉ CAMBIA RESPECTO DEL DISEÑO
 *
 *   1. EL ICONO. El original tenía tres barras (un menú hamburguesa). Aquí es
 *      un BOLETO, como pediste, hecho con `mask-image` para que tome el color
 *      del texto sin duplicar el SVG.
 *   2. EL COLOR. El original era `#040f16` (casi negro) con `#f5f5f5`. Se
 *      mantiene el azul del sistema, igual que el resto de los botones
 *      primarios, para no meter un tercer color de acción en la consola.
 *   3. EL ANCHO. Los 150 px fijos del original no caben bien en la tarjeta de
 *      emisión a 320 px. El botón ocupa el ancho disponible (`w-full` desde
 *      fuera) y el icono se centra en lo que haya.
 *   4. `outline: none` en `:focus`. Eso dejaba el botón sin ninguna señal de
 *      foco al navegar con el teclado, que es un fallo de accesibilidad real
 *      (WCAG 2.4.7). Aquí el foco dibuja un anillo.
 */
import type { ButtonHTMLAttributes } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode
}

export default function BotonEmitir({
  children = 'Emitir turno',
  className = '',
  ...resto
}: Props) {
  return (
    <button type="button" className={`boton-emitir ${className}`} {...resto}>
      <span className="boton-emitir-icono bi--ticket-fill" aria-hidden="true" />
      <span className="boton-emitir-texto">{children}</span>
    </button>
  )
}
