/*
 * Bloque que crece y se encoge con animación cuando cambia su contenido.
 *
 * PARA QUÉ
 * En la consola, el panel de emisión mide ~200 px en «Un turno» y ~500 px en
 * «Varios turnos». Al cambiar de modo, el salto era instantáneo: la tarjeta,
 * el resto de la columna y el pie de la página se movían en el mismo
 * fotograma. Eso se lee como un parpadeo, no como un cambio.
 *
 * CÓMO FUNCIONA
 * `height: auto` no se puede animar. La solución barata (`max-height` con un
 * valor grande) da una curva falsa: anima de 0 a ese valor máximo aunque el
 * contenido mida menos, así que el primer tramo no se mueve nada y luego
 * salta. Aquí se mide la altura real y se anima de la anterior a la nueva:
 *
 *   1. Antes de pintar (`useLayoutEffect`), se lee la altura actual con
 *      `getBoundingClientRect` y se fija como `height` en píxeles.
 *   2. Se fuerza un reflow leyendo `offsetHeight`, para que el navegador
 *      registre el punto de partida.
 *   3. Se cambia a la altura nueva. Como ambas son píxeles conocidos, el
 *      navegador sí interpola.
 *   4. Al terminar, se quita el `height` fijo para que el bloque vuelva a
 *      `auto` y crezca solo si el contenido cambia (por ejemplo, al añadir un
 *      renglón de trámite).
 *
 * POR QUÉ SE MIDE CON `ResizeObserver`
 * Si el contenido interno crece estando en `auto` (añadir un trámite en el
 * modo masivo), no hay cambio de `children` que anime: el bloque crece y ya.
 * Eso está bien. El `ResizeObserver` no se usa para animar eso, sino para no
 * quedarse con una altura fija obsoleta si el bloque se queda en modo fijo.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type Props = {
  /** Cambia cuando el contenido cambia de tamaño. Suele ser el modo. */
  clave: string | number | boolean
  children: ReactNode
  className?: string
}

export default function BloqueExpandible({ clave, children, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [alto, setAlto] = useState<number | 'auto'>('auto')
  const anterior = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    /*
     * Si el sistema pide menos movimiento, se deja en `auto` y no se anima
     * nada. Un salto de 300 px animado es justo lo que esa preferencia pide
     * evitar.
     */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAlto('auto')
      anterior.current = el.getBoundingClientRect().height
      return
    }

    const nuevo = el.getBoundingClientRect().height

    /*
     * Primer montaje: no hay de dónde animar, así que se fija la altura y ya.
     * Sin esta salida, el bloque aparecería creciendo desde 0 al abrir la
     * pantalla.
     */
    if (anterior.current === null) {
      anterior.current = nuevo
      setAlto(nuevo)
      return
    }

    /*
     * El contenido nuevo ya está en el DOM con la altura fija anterior, así
     * que ese es el punto de partida. Se pasa a la altura nueva en el
     * siguiente fotograma para que el navegador vea el cambio.
     */
    setAlto(anterior.current)
    const id = requestAnimationFrame(() => {
      setAlto(nuevo)
      anterior.current = nuevo
    })
    return () => cancelAnimationFrame(id)
  }, [clave])

  // Vuelve a `auto` cuando termina la transición: si no, el bloque se queda
  // con una altura fija y se recorta al añadir contenido.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let t: ReturnType<typeof setTimeout>
    const alTerminar = (e: TransitionEvent) => {
      if (e.propertyName !== 'height') return
      el.style.height = 'auto'
      setAlto('auto')
    }
    el.addEventListener('transitionend', alTerminar)
    // Red de seguridad: si la transición no dispara (pestaña en segundo
    // plano, por ejemplo), no dejar el bloque con altura fija para siempre.
    if (alto !== 'auto') t = setTimeout(() => setAlto('auto'), 600)
    return () => {
      el.removeEventListener('transitionend', alTerminar)
      clearTimeout(t)
    }
  }, [alto])

  return (
    <div
      ref={ref}
      className={`bloque-expandible ${className}`}
      style={{ height: alto === 'auto' ? undefined : alto }}
    >
      {children}
    </div>
  )
}
