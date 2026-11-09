import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ETIQUETA_ESTADO, ETIQUETA_PRIORIDAD } from '../lib/tipos'
import type { EstadoTurno, PrioridadTurno } from '../lib/tipos'

/**
 * Piezas visuales compartidas del panel.
 *
 * Principio: la UI nunca muestra el enum crudo de la base. Los estados se
 * traducen aquí, en un solo sitio, para que el significado sea el mismo en
 * toda la consola.
 */

const ESTILO_ESTADO: Record<EstadoTurno, string> = {
  WAITING: 'bg-gris-100 text-gris-700',
  CALLED: 'bg-ambar-50 text-ambar-600',
  SERVING: 'bg-verde-50 text-verde-600',
  COMPLETED: 'bg-gris-50 text-gris-700',
  CANCELLED: 'bg-rojo-50 text-rojo-600',
  SKIPPED: 'bg-rojo-50 text-rojo-600',
}

/**
 * Aquí vivía la marca del sistema (un monograma «SC» y después un símbolo de
 * boleto). Se retiró: SITUR no es una marca, es una herramienta interna de la
 * Dirección de Catastro, y un símbolo inventado en la cabecera no aportaba
 * información: competía con el nombre del sistema sin decir nada. Cuando la
 * dependencia entregue su escudo institucional, va en la cabecera como imagen,
 * no como un icono dibujado aquí.
 */

export function ChipEstado({ estado }: { estado: EstadoTurno }) {
  return (
    <span className={`etiqueta ${ESTILO_ESTADO[estado]}`}>{ETIQUETA_ESTADO[estado]}</span>
  )
}

export function ChipPrioridad({ prioridad }: { prioridad: PrioridadTurno }) {
  /*
   * Antes, «Normal» no pintaba nada: la columna «Prioridad» salia vacia
   * en la mayoria de las filas, y una columna vacia se lee como un fallo
   * de la pantalla, no como una ausencia de prioridad. Ahora «Normal» se
   * dice, en gris, que es lo que significa: que no tiene nada especial.
   */
  const urgente = prioridad === 'URGENTE'
  const preferente = prioridad === 'PREFERENTE'
  const tono = urgente
    ? 'bg-rojo-50 text-rojo-600'
    : preferente
      ? 'bg-ambar-50 text-ambar-600'
      : 'bg-gris-100 text-gris-700'
  return (
    <span className={`etiqueta ${tono}`}>
      {ETIQUETA_PRIORIDAD[prioridad]}
    </span>
  )
}

export function Chip({ children, tono = 'neutro' }: {
  children: ReactNode
  tono?: 'neutro' | 'ok' | 'alerta' | 'peligro'
}) {
  const tonos = {
    neutro: 'bg-gris-100 text-gris-700',
    ok: 'bg-verde-50 text-verde-600',
    alerta: 'bg-ambar-50 text-ambar-600',
    peligro: 'bg-rojo-50 text-rojo-600',
  }
  return <span className={`etiqueta ${tonos[tono]}`}>{children}</span>
}

/** Estado vacío: explica qué hacer, no solo "no hay datos". */
export function Vacio({ titulo, detalle, icono }: {
  titulo: string
  detalle?: string
  icono?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icono && <div className="text-gris-500">{icono}</div>}
      <p className="text-sm font-semibold text-gris-700">{titulo}</p>
      {detalle && <p className="max-w-sm text-sm text-gris-500">{detalle}</p>}
    </div>
  )
}

/** Aviso en línea (errores de una operación, confirmaciones). */
export function Aviso({ tono, children }: {
  tono: 'ok' | 'alerta' | 'peligro'
  children: ReactNode
}) {
  const tonos = {
    ok: 'border-verde-500/30 bg-verde-50 text-verde-600',
    alerta: 'border-ambar-500/30 bg-ambar-50 text-ambar-600',
    peligro: 'border-rojo-500/30 bg-rojo-50 text-rojo-600',
  }
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm font-medium ${tonos[tono]}`}>
      {children}
    </div>
  )
}

/**
 * Diálogo modal.
 *
 * Escape cierra, el foco queda atrapado dentro y vuelve al elemento que lo
 * abrió (WCAG 2.1.1, 2.1.2 y 2.4.3). Sin esto, el foco se escapa a la
 * página de detrás y el operador de teclado queda perdido.
 */
export function Modal({ titulo, onCerrar, children, ancho = 'max-w-lg' }: {
  titulo: string
  onCerrar: () => void
  children: ReactNode
  ancho?: string
}) {
  const refDialog = useRef<HTMLDivElement>(null)
  const refPrevio = useRef<HTMLElement | null>(null)

  /*
   * Cierre animado.
   *
   * React desmonta el nodo en el mismo instante en que el padre deja de
   * renderizarlo, así que una animación de salida en CSS nunca llegaría a
   * verse. `saliendo` retrasa el desmontaje lo que dura la animación: primero
   * se pinta la clase de salida y, cuando termina, se llama al `onCerrar`
   * real del padre.
   *
   * `prefers-reduced-motion` se respeta sin lógica aquí: el CSS deja la
   * animación en `none` y `animationend` no se dispara, así que el `setTimeout`
   * de respaldo (ver abajo) cierra el diálogo igual de rápido.
   */
  const [saliendo, setSaliendo] = useState(false)

  const cerrar = useCallback(() => {
    setSaliendo(true)
    // Respaldo: si `animationend` no llega (animación desactivada por
    // accesibilidad, pestaña en segundo plano), se cierra igual.
    window.setTimeout(() => onCerrar(), 180)
  }, [onCerrar])

  useEffect(() => {
    refPrevio.current = document.activeElement as HTMLElement | null
    const dialogo = refDialog.current

    const SELECCION =
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), ' +
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

    // El primer control del diálogo recibe el foco.
    dialogo?.querySelector<HTMLElement>(SELECCION)?.focus()

    function alPulsarTecla(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        cerrar()
        return
      }
      if (e.key !== 'Tab' || !dialogo) return

      // Trampa de foco: el tabulador cicla dentro del diálogo.
      const enfocables = Array.from(dialogo.querySelectorAll<HTMLElement>(SELECCION)).filter(
        (el) => el.offsetParent !== null,
      )
      if (enfocables.length === 0) {
        e.preventDefault()
        return
      }

      const primero = enfocables[0]
      const ultimo = enfocables[enfocables.length - 1]
      const activo = document.activeElement as HTMLElement | null

      if (e.shiftKey && (activo === primero || !dialogo.contains(activo))) {
        e.preventDefault()
        ultimo.focus()
      } else if (!e.shiftKey && (activo === ultimo || !dialogo.contains(activo))) {
        e.preventDefault()
        primero.focus()
      }
    }

    document.addEventListener('keydown', alPulsarTecla, true)
    return () => {
      document.removeEventListener('keydown', alPulsarTecla, true)
      // El foco vuelve a donde estaba.
      refPrevio.current?.focus?.()
    }
  }, [cerrar])

  return (
    <div
      className={`modal-velo ${saliendo ? 'modal-saliendo' : ''} fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-navy-900/40 p-0 backdrop-blur-[3px] sm:items-center sm:p-4`}
      onClick={cerrar}
      role="presentation"
    >
      <div
        ref={refDialog}
        className={`modal-caja w-full ${ancho} rounded-t-2xl bg-white shadow-xl sm:rounded-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
      >
        <div className="flex items-center justify-between border-b border-gris-100 px-5 py-4">
          <h2 className="text-base font-bold text-navy-800">{titulo}</h2>
          <button
            type="button"
            onClick={cerrar}
            className="rounded-lg p-1.5 text-gris-500 transition-colors hover:bg-gris-50 hover:text-gris-700"
            aria-label="Cerrar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

/** Campo de texto con etiqueta. */
export function Campo({ etiqueta, children, ayuda, grupo = false }: {
  etiqueta: string
  children: ReactNode
  ayuda?: string
  /**
   * `grupo` cambia el `<label>` por un `<div>`.
   *
   * Hace falta cuando el control NO es un campo nativo: el `<label>` solo
   * asocia correctamente con `<input>`, `<select>` y `<textarea>`. Metido
   * dentro de un label, un botón (el `Selector` propio) hace que al pulsar la
   * etiqueta se dispare el botón, y además es HTML inválido: un botón dentro
   * de un label es contenido interactivo dentro de contenido interactivo.
   *
   * En ese caso el nombre accesible lo lleva el propio botón (`aria-label`),
   * así que la etiqueta visible es solo texto.
   */
  grupo?: boolean
}) {
  const Etiqueta = grupo ? 'div' : 'label'
  return (
    <Etiqueta className="block">
      {/*
        Separación entre la etiqueta y su control: 8px.

        Antes era 6px (`mb-1.5`) y, junto a la altura del select, la etiqueta
        quedaba pegada a la caja. Con 8px el campo se lee como una unidad sin
        que la etiqueta se despegue.

        La ayuda sube de 4px a 6px por lo mismo: con 4px el texto de RN-017 se
        confundía con el borde inferior del select.
      */}
      <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-gris-700">
        {etiqueta}
      </span>
      {children}
      {ayuda && <span className="mt-1.5 block text-xs text-gris-500">{ayuda}</span>}
    </Etiqueta>
  )
}

/**
 * Esqueleto de carga.
 *
 * Por qué existe: las pantallas usaban `<Vacio titulo="Cargando…" />`, que es
 * texto centrado en una caja vacía. Al cambiar de sección el contenido
 * anterior desaparecía y durante un frame se veía un hueco en blanco antes de
 * que llegaran los datos. El salto de altura se notaba más que la espera.
 *
 * Un esqueleto con la MISMA forma que el contenido final hace que el cambio
 * sea limpio: el hueco ya tiene el tamaño correcto y los datos simplemente lo
 * rellenan, sin salto.
 *
 * `aria-busy` + `aria-hidden` en el dibujo: el lector de pantalla anuncia
 * «cargando» una vez y no lee una lista de cajas vacías.
 */
export function Esqueleto({
  filas = 5,
  alto = 'h-4',
  className = '',
}: {
  /** Cuántas barras dibujar. */
  filas?: number
  /** Clase de alto de cada barra. */
  alto?: string
  className?: string
}) {
  return (
    <div className={`space-y-3 ${className}`} aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando…</span>
      {Array.from({ length: filas }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={`esqueleto-bloque ${alto} rounded-md`}
          /* Anchos distintos por fila: una columna de barras iguales parece
             un error de maquetación, no un contenido que está por llegar. */
          style={{ width: `${100 - (i % 3) * 8}%` }}
        />
      ))}
    </div>
  )
}

/**
 * Esqueleto de tabla: cabecera + filas.
 *
 * Se usa donde el contenido real es una tabla, para que el esqueleto tenga el
 * mismo número de columnas y el mismo alto de fila.
 */
export function EsqueletoTabla({
  columnas = 4,
  filas = 6,
}: {
  columnas?: number
  filas?: number
}) {
  return (
    <div className="w-full" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando…</span>
      {/* Cabecera */}
      <div aria-hidden="true" className="flex gap-4 border-b border-gris-100 bg-gris-50 px-6 py-3">
        {Array.from({ length: columnas }).map((_, i) => (
          <div
            key={i}
            className="esqueleto-bloque h-3 rounded"
            style={{ width: `${100 / columnas}%`, opacity: 0.6 }}
          />
        ))}
      </div>
      {/* Filas */}
      {Array.from({ length: filas }).map((_, f) => (
        <div
          key={f}
          aria-hidden="true"
          className="flex items-center gap-4 border-b border-gris-100 px-6 py-4"
        >
          {Array.from({ length: columnas }).map((_, c) => (
            <div
              key={c}
              className="esqueleto-bloque h-4 rounded"
              style={{ width: `${100 / columnas}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Esqueleto de tarjetas: la rejilla de cifras de Estadísticas.
 */
export function EsqueletoTarjetas({ n = 4 }: { n?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Cargando…</span>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} aria-hidden="true" className="tarjeta p-6">
          <div className="esqueleto-bloque mb-3 h-3 w-2/3 rounded" />
          <div className="esqueleto-bloque h-8 w-1/2 rounded" />
        </div>
      ))}
    </div>
  )
}

/**
 * Retardo mínimo del esqueleto, si algún día se usa.
 *
 * NO se aplica de forma global a propósito: en una pantalla que tarda 40 ms,
 * forzar 150 ms hace la aplicación MÁS lenta de lo que era. Se queda aquí como
 * utilidad documentada y sin usar, para no repetir la discusión.
 *
 * Si en el futuro se quisiera usar, el tope debe ser corto (≤200 ms) y solo
 * donde la carga sea rápida y el destello frecuente.
 */
export const RETARDO_MINIMO_ESQUELETO_MS = 150
