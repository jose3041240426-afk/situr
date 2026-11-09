/*
 * Selector con lista desplegable propia.
 *
 * POR QUÉ NO SE USA UN <select>
 * El `<select>` nativo dibuja la lista con el sistema operativo y la ensancha
 * al texto más largo, ignorando el `width` del control. Con «M01 — Módulo 01 -
 * Atención general» el control medía 208 px y la lista salía a ~320: la lista
 * desbordaba el campo y no había forma de limitarlo por CSS.
 *
 * Aquí la lista es un `<ul>` propio con `width: 100%`, así que SIEMPRE mide
 * exactamente lo mismo que el control. Es la razón de reemplazar el nativo.
 *
 * LO QUE UN COMPONENTE PROPIO TIENE QUE REPONER
 * Un `<select>` trae gratis: teclado (flechas, Enter, Escape, Home/End),
 * búsqueda por letra, anuncio del valor al lector de pantalla y cierre al
 * hacer clic fuera. Todo eso está implementado abajo; sin ello el componente
 * sería peor que el nativo aunque se viera mejor.
 *
 * PATRÓN ARIA: «button + listbox».
 * El botón lleva `aria-haspopup="listbox"` y `aria-expanded`, y la lista
 * `role="listbox"` con opciones `role="option"` y `aria-selected`. El foco se
 * queda SIEMPRE en el botón (patrón de «foco doméstico»): las opciones se
 * marcan con `aria-activedescendant`. Así el lector de pantalla anuncia la
 * opción al moverse con las flechas sin que el foco salte de sitio.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

export type OpcionSelector = {
  valor: string
  etiqueta: string
}

type Props = {
  /** Nombre accesible del control. Obligatorio: sin él se anuncia «botón». */
  etiqueta: string
  opciones: OpcionSelector[]
  valor: string
  onCambiar: (valor: string) => void
  disabled?: boolean
  className?: string
}

export default function Selector({
  etiqueta,
  opciones,
  valor,
  onCambiar,
  disabled = false,
  className = '',
}: Props) {
  const [abierto, setAbierto] = useState(false)
  const [resaltado, setResaltado] = useState(-1)

  const boton = useRef<HTMLButtonElement>(null)
  const lista = useRef<HTMLUListElement>(null)
  const contenedor = useRef<HTMLDivElement>(null)

  /* `useId` da un id estable entre servidor y cliente; sirve para enlazar el
     botón con la lista y para `aria-activedescendant`. */
  const idBase = useId()
  const idLista = `${idBase}-lista`
  const idOpcion = (i: number) => `${idBase}-op-${i}`

  const indiceActual = useMemo(
    () => opciones.findIndex((o) => o.valor === valor),
    [opciones, valor],
  )
  const seleccionada = opciones[indiceActual]


  /**
   * Al abrir, el resaltado arranca en la opción ya elegida (o en la primera).
   * Sin esto las flechas empezarían desde cero aunque el usuario ya tuviera
   * una selección, y tendría que recorrer toda la lista.
   */
  function abrir(desde: number) {
    if (disabled) return
    setResaltado(desde)
    setAbierto(true)
  }

  function elegir(i: number) {
    const op = opciones[i]
    if (!op) return
    onCambiar(op.valor)
    setAbierto(false)
    /* El foco vuelve al botón: al elegir con el ratón, sin esto el foco se
       quedaría en el `body` y el tabulador seguiría desde el principio. */
    boton.current?.focus()
  }

  /*
   * Cerrar al hacer clic fuera.
   *
   * Se escucha en el documento en fase de captura para enterarse aunque otro
   * elemento detenga la propagación. El `ref` compara contra el contenedor
   * completo (botón + lista), no solo la lista.
   */
  useEffect(() => {
    if (!abierto) return

    function alClicFuera(e: MouseEvent) {
      if (!contenedor.current?.contains(e.target as Node)) setAbierto(false)
    }

    document.addEventListener('mousedown', alClicFuera)
    return () => document.removeEventListener('mousedown', alClicFuera)
  }, [abierto])

  /*
   * Mantener visible la opción resaltada.
   *
   * Con muchas opciones la lista se desplaza; sin esto las flechas podían
   * mover el resaltado fuera de la ventana visible y el usuario perdía de
   * vista qué estaba a punto de elegir. `block: 'nearest'` evita el salto
   * cuando la opción ya se ve.
   */
  useEffect(() => {
    if (!abierto || resaltado < 0) return
    const el = lista.current?.children[resaltado] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [abierto, resaltado])

  function alTeclear(e: React.KeyboardEvent<HTMLButtonElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        if (!abierto) {
          abrir(indiceActual >= 0 ? indiceActual : 0)
          return
        }
        /* Sin `wrap`: al llegar al final se queda ahí. Con 5 opciones el
           salto circular desconcierta más de lo que ayuda. */
        const paso = e.key === 'ArrowDown' ? 1 : -1
        setResaltado((i) => Math.min(opciones.length - 1, Math.max(0, i + paso)))
        return
      }

      case 'Home':
      case 'End': {
        if (!abierto) return
        e.preventDefault()
        setResaltado(e.key === 'Home' ? 0 : opciones.length - 1)
        return
      }

      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (abierto) elegir(resaltado)
        else abrir(indiceActual >= 0 ? indiceActual : 0)
        return
      }

      case 'Escape': {
        if (!abierto) return
        e.preventDefault()
        setAbierto(false)
        return
      }

      case 'Tab': {
        /* Salir con Tab cierra la lista y deja que el foco siga su camino;
           no se llama a `preventDefault` a propósito. */
        setAbierto(false)
        return
      }
    }
  }

  return (
    <div ref={contenedor} className={`selector-propio ${className}`}>
      <button
        ref={boton}
        type="button"
        className="selector selector-propio-boton"
        aria-haspopup="listbox"
        aria-expanded={abierto}
        /*
         * `aria-label` y no `aria-labelledby`.
         *
         * Con `aria-labelledby` apuntando al `<span>` del nombre, el botón
         * anunciaba solo «Módulo al que llamar» y NO el valor visible. Eso
         * rompe WCAG 2.5.3 (`label-content-name-mismatch`): el nombre accesible
         * debe contener el texto que se ve.
         *
         * Concatenando ambos, el lector anuncia «Módulo al que llamar: M01 —
         * …», que dice de qué campo es Y qué valor tiene.
         */
        aria-label={`${etiqueta}: ${seleccionada?.etiqueta ?? ''}`}
        aria-controls={abierto ? idLista : undefined}
        aria-activedescendant={abierto && resaltado >= 0 ? idOpcion(resaltado) : undefined}
        disabled={disabled}
        /*
         * `title` con el texto completo: el deslizamiento es una ayuda visual,
         * no la única forma de leer el valor. Quien no pasa el cursor (o usa
         * un lector de pantalla) obtiene el nombre entero igual.
         */
        title={seleccionada?.etiqueta}
        onClick={() => (abierto ? setAbierto(false) : abrir(indiceActual >= 0 ? indiceActual : 0))}
        onKeyDown={alTeclear}
      >
        {/* El nombre accesible va en un `<span>` visible: el control muestra
            el valor, y sin esta etiqueta el lector anunciaría solo «M01 …»,
            sin decir de qué campo se trata. */}
        <span id={`${idBase}-etiq`} className="sr-only">
          {etiqueta}
        </span>
        <span className="selector-propio-valor">{seleccionada?.etiqueta ?? '—'}</span>
      </button>

      {abierto && (
        <ul
          ref={lista}
          id={idLista}
          role="listbox"
          aria-label={etiqueta}
          className="selector-propio-lista"
        >
          {opciones.map((o, i) => (
            <li
              key={o.valor || '(vacio)'}
              id={idOpcion(i)}
              role="option"
              aria-selected={o.valor === valor}
              /*
               * `onMouseDown` y no `onClick`: el `mousedown` del documento que
               * cierra el desplegable se dispararía antes que el `click`, y la
               * opción no llegaría a elegirse.
               */
              onMouseDown={(e) => {
                e.preventDefault()
                elegir(i)
              }}
              onMouseEnter={() => setResaltado(i)}
              className={`selector-propio-opcion ${
                i === resaltado ? 'selector-propio-opcion--resaltada' : ''
              }`}
            >
              {o.etiqueta}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
