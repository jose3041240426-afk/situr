/*
 * Botón con destello, para la acción de abrir/cerrar el periodo operativo.
 *
 * Es la única acción de la consola que cambia el estado de todo el día: si el
 * periodo está cerrado no se puede emitir ningún turno. Por eso lleva este
 * tratamiento llamativo y no el `boton-primario` de siempre.
 *
 * PORTADO A TAILWIND
 * El diseño original venía con styled-components, que este proyecto no usa
 * (el resto del sistema es Tailwind 4 y `npm run colores` verifica las clases
 * de color contra el CSS compilado, algo que no ve los estilos en línea). Se
 * reproduce el mismo efecto con variables CSS y clases del proyecto.
 *
 * ESTADOS
 *   periodo abierto  -> rojo,  «Cerrar periodo»      (acción destructiva)
 *   periodo cerrado  -> verde, «Abrir periodo de hoy» (acción que habilita)
 *
 * ACCESIBILIDAD
 * - El brillo del borde es decorativo: `aria-hidden` y
 *   `pointer-events: none`, para que no aparezcan en el árbol accesible ni
 *   capturen el puntero.
 * - Todo el efecto (giro y destello del borde) se apaga con
 *   `prefers-reduced-motion`, porque es movimiento continuo en el borde del
 *   campo visual (WCAG 2.3.3).
 * - El foco visible lo pone el `:focus-visible` global del proyecto; aquí se
 *   añade un anillo propio porque la sombra de color del botón lo taparía.
 */
export default function BotonChispa({
  tono,
  onClick,
  disabled,
  children,
}: {
  tono: 'rojo' | 'verde'
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="chispa"
      data-tono={tono}
    >
      {/* El giro del destello, recortado con `mask` para que solo se vea el
          borde superior del botón. */}
      <span className="chispa-giro" aria-hidden="true" />
      {/* El fondo opaco que tapa el centro del giro y deja ver solo el filo. */}
      <span className="chispa-fondo" aria-hidden="true" />
      <span className="chispa-texto">{children}</span>
    </button>
  )
}
