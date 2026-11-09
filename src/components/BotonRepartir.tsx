/*
 * Botón «Repartir»: cuatro bolitas y una caída al pulsar.
 *
 * QUÉ HACE
 *   Reposo     → solo el texto.
 *   Hover      → el texto se desvanece y cuatro bolitas salen del centro y se
 *                colocan arriba, abajo, izquierda y derecha. Se quedan quietas.
 *   Clic       → las cuatro caen por gravedad desde SU posición, cada una
 *                moviéndose recta hacia abajo, y se desvanecen.
 *
 * POR QUÉ EL ESTADO VIVE AQUÍ Y NO EN CSS
 * El primer intento usaba `:active`, y fallaba por dos motivos:
 *
 *   1. `:active` solo dura mientras el botón está presionado. Al soltar el
 *      ratón el estado desaparece y la animación se corta a medias. La caída
 *      tiene que terminar sola aunque el cursor ya se haya ido.
 *
 *   2. En CSS todas las bolitas comparten la misma regla, así que la caída las
 *      obligaba a volver al centro antes de bajar (fase `0%` con
 *      `translate(0, 0)`). Se veía una sola bolita cayendo en lugar de cuatro.
 *
 * Con estado en React cada bolita conserva SU posición y cae desde ahí: el
 * `@keyframes` arranca en `var(--dx) / var(--dy)` en vez de en el centro.
 *
 * El estado se limpia con un temporizador (duración + retardo mayor) para que
 * se pueda volver a pulsar.
 */
import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: React.ReactNode
}

/**
 * Hacia dónde se separa cada bolita.
 *
 * El desplazamiento horizontal (15) es mayor que el vertical (13) porque el
 * botón es más ancho que alto: con el mismo valor las de los lados quedaban
 * más cerca del borde que las de arriba y abajo.
 */
const DIRECCIONES = [
  { dx: 0, dy: -13 }, // arriba
  { dx: 0, dy: 13 }, // abajo
  { dx: -15, dy: 0 }, // izquierda
  { dx: 15, dy: 0 }, // derecha
]

/** Duración de la caída. Debe coincidir con el `@keyframes` en el CSS. */
const DURACION_CAIDA_MS = 520

export default function BotonRepartir({
  children = 'Repartir',
  className = '',
  onClick,
  ...resto
}: Props) {
  /*
   * `cayendo` se enciende al pulsar y se apaga cuando la animación termina.
   * Mientras está encendido, la clase `boton-repartir--cae` aplica el
   * `@keyframes` de caída a las cuatro bolitas.
   */
  const [cayendo, setCayendo] = useState(false)

  /*
   * `agotado` es distinto de `cayendo`.
   *
   *   cayendo → las bolitas están en el aire (los ~520 ms de la animación).
   *   agotado → la caída YA terminó, pero el cursor sigue encima del botón.
   *
   * Sin `agotado`, al limpiar `cayendo` la regla `.boton-repartir:hover`
   * volvía a aplicarse —el ratón nunca se movió— y las bolitas reaparecían
   * solas. Con este estado el botón se queda azul limpio hasta que el cursor
   * SALE, que es cuando se reinicia todo.
   */
  const [agotado, setAgotado] = useState(false)

  /*
   * Temporizador guardado en una ref, no en el estado: cambiarlo no debe
   * provocar un render, solo cancelarse si se pulsa otra vez antes de que
   * termine la caída anterior.
   */
  const temporizador = useRef<number | null>(null)

  /* Limpieza al desmontar: evita el aviso de setState sobre componente
     desmontado si el usuario navega justo después de pulsar. */
  useEffect(() => {
    return () => {
      if (temporizador.current !== null) window.clearTimeout(temporizador.current)
    }
  }, [])

  function manejarClic(e: React.MouseEvent<HTMLButtonElement>) {
    /* Reinicia la animación si se pulsa otra vez mientras cae. */
    setAgotado(false)
    setCayendo(false)
    window.requestAnimationFrame(() => setCayendo(true))

    if (temporizador.current !== null) window.clearTimeout(temporizador.current)
    temporizador.current = window.setTimeout(() => {
      setCayendo(false)
      /* La caída terminó: se marca agotado para que el `:hover` no devuelva
         las bolitas mientras el cursor siga encima. */
      setAgotado(true)
      temporizador.current = null
    }, DURACION_CAIDA_MS)

    onClick?.(e)
  }

  return (
    <button
      type="button"
      className={`boton-repartir ${cayendo ? 'boton-repartir--cae' : ''} ${
        agotado ? 'boton-repartir--agotado' : ''
      } ${className}`}
      /*
       * Al salir el cursor se reinicia todo: la próxima entrada vuelve a
       * separar las bolitas desde el centro.
       */
      onMouseLeave={() => setAgotado(false)}
      onClick={manejarClic}
      {...resto}
    >
      <span className="boton-repartir-texto">{children}</span>
      <span className="boton-repartir-puntos" aria-hidden="true">
        {DIRECCIONES.map((d, i) => (
          <span
            key={i}
            className="boton-repartir-punto"
            style={
              {
                '--dx': `${d.dx}px`,
                '--dy': `${d.dy}px`,
                /* Cada bolita sale un poco después de la anterior, así el
                   reparto se lee en cadena y no como un estallido. */
                '--retardo': `${i * 0.04}s`,
              } as React.CSSProperties
            }
          />
        ))}
      </span>
    </button>
  )
}
