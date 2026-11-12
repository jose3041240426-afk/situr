import { useId, useMemo } from 'react'
import { createAvatar } from '@blobz/avatar-core'
import { cn } from '../../lib/utils'

/**
 * SITUR — Avatar del operador.
 *
 * El sistema no guarda fotos de perfil: el ciudadano nunca deja datos
 * personales y el operador tampoco tiene por qué dejar una imagen en un
 * servidor del municipio. Lo que se pone es un **avatar generado**, que se
 * dibuja en el navegador a partir del nombre.
 *
 * La generación es **determinista**: la misma cadena produce siempre el
 * mismo dibujo. No hay semilla aleatoria que guardar ni archivo que subir, y
 * dos equipos distintos muestran la misma cara para la misma cuenta.
 *
 * La biblioteca es `blobz` (MIT), que hace el hash del nombre con una
 * paleta y reparte las características del dibujo (ojos, boca, tocado) de
 * forma estable.
 *
 * POR QUÉ NO SE USA EL COMPONENTE DE SHADCN DE BLOBZ
 *
 * El registro de shadcn de blobz (`npx shadcn add @blobz/avatar`) arrastra
 * `@base-ui/react` para los primitivos de avatar. Este proyecto ya usa Radix
 * para lo demás, y meter una segunda biblioteca de primitivos para dibujar
 * una cara sería mucho mecanismo para poco. Aquí se usa el núcleo
 * (`@blobz/avatar-core`), que no depende de React ni de ninguna biblioteca de
 * interfaz, y el envoltura se hace aquí.
 */

/** Tamaños, en la misma escala que el resto del sistema. */
const TAMANOS = {
  sm: 'size-8',
  md: 'size-12',
  lg: 'size-16',
  xl: 'size-24',
  '2xl': 'size-32',
} as const

export type TamanoAvatar = keyof typeof TAMANOS

export interface AvatarProps {
  /** La cadena que decide el dibujo. Normalmente el nombre completo. */
  nombre: string
  tamano?: TamanoAvatar
  /** Texto que se anuncia en lugar de la imagen. */
  etiqueta?: string
  className?: string
  /** Redondeo del recorte. */
  marco?: 'circle' | 'rounded' | 'square'
}

/**
 * La paleta del sistema: azul de acción sobre un azul muy claro.
 *
 * Blobz usa el primer color como relleno y el segundo como acento. Se eligen
 * los del tema para que el avatar no desentone al lado de la barra azul.
 */
const PALETA: [string, string] = ['#e8f0fb', '#1273ea']

/**
 * Quita el tamaño fijo y deja el SVG al mando del CSS.
 *
 * Blobz emite `width="80" height="80"`, que en un `size-12` se pelearía con
 * el tamaño de la caja: el SVG se saldría del círculo. Con las dimensiones
 * fuera, manda la clase.
 */
function preparar(svg: string, etiqueta: string, prefijo: string): string {
  let salida = svg
    .replace(/\swidth="80"/, '')
    .replace(/\sheight="80"/, '')
    .replace(/aria-label="[^"]*"/, `aria-label="${etiqueta}"`)

  /*
   * Los `id` del SVG (clipPath, mask, linearGradient) son fijos para un
   * mismo nombre: el dibujo es determinista y el SVG sale byte a byte igual.
   *
   * Si el mismo SVG se pintara dos veces en la página, el navegador reutilizaría
   * el `clipPath` del primero para los dos, y el `id` quedaría duplicado en
   * el documento. Con un prefijo único por instancia, cada dibujo lleva sus
   * propias referencias y el documento no repite identificadores.
   */
  salida = salida.replace(/id="([^"]+)"/g, (_, id: string) => `id="${prefijo}-${id}"`)
  salida = salida.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefijo}-${id})`)
  salida = salida.replace(/href="#([^"]+)"/g, (_, id: string) => `href="#${prefijo}-${id}"`)

  return salida
}

export function Avatar({
  nombre,
  tamano = 'md',
  etiqueta,
  className,
  marco = 'rounded',
}: AvatarProps) {
  /*
   * `useId` da un identificador estable y único por instancia. React lo
   * genera con dos puntos y una C, que no valen dentro de un atributo `id`
   * de SVG como selector de URL… sí valen (son caracteres válidos en XML),
   * pero se limpian para que el documento quede legible.
   */
  const idUnico = useId().replace(/[^a-zA-Z0-9]/g, '')

  const limpio = nombre.trim()
  const texto = etiqueta ?? `Avatar de ${limpio || 'operador'}`

  const svg = useMemo(() => {
    if (!limpio) return null
    const generado = createAvatar({
      name: limpio,
      palette: PALETA,
      frame: marco,
    })
    return preparar(generado.svg, texto, idUnico)
  }, [limpio, marco, texto, idUnico])

  const formas = {
    circle: 'rounded-full',
    rounded: 'rounded-[22.5%]',
    square: 'rounded-none',
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden bg-gris-100',
        formas[marco],
        TAMANOS[tamano],
        className,
      )}
      aria-hidden={svg ? undefined : true}
    >
      {svg ? (
        <span
          className="block size-full"
          // El SVG viene de la biblioteca y se limpia antes de entrar: solo
          // trazados, sin scripts ni eventos. Es el mismo SVG que la
          // biblioteca genera en local.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <span className="text-xs font-bold text-gris-500">
          {(limpio[0] ?? '?').toUpperCase()}
        </span>
      )}
    </span>
  )
}
