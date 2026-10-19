import { useEffect, useRef } from 'react'
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
  WAITING: 'bg-institucional-100 text-institucional-700',
  CALLED: 'bg-alerta-50 text-alerta-700',
  SERVING: 'bg-ok-50 text-ok-700',
  COMPLETED: 'bg-institucional-50 text-institucional-500',
  CANCELLED: 'bg-peligro-50 text-peligro-700',
  SKIPPED: 'bg-peligro-50 text-peligro-700',
}

/**
 * La marca del sistema.
 *
 * Antes era un monograma «SC» al lado del nombre «SITUR», que se contradecía:
 * dos siglas distintas para lo mismo, en el mismo trozo de pantalla. Ahora es
 * un símbolo —un boleto con su línea de perforación, que es literalmente lo
 * que el sistema emite— y el nombre va al lado, sin competir con él.
 *
 * Deliberadamente NO se inventa un escudo: la marca institucional del
 * municipio es del municipio, y este sitio es una herramienta interna. Cuando
 * el municipio entregue su escudo, este componente es el único sitio donde
 * hay que cambiarlo.
 */
export function Marca({ tamano = 'md' }: { tamano?: 'md' | 'lg' }) {
  const grande = tamano === 'lg'
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-2xl bg-institucional-600 text-white ${
        grande ? 'h-14 w-14' : 'h-9 w-9'
      }`}
      aria-hidden="true"
    >
      <svg
        width={grande ? 30 : 21}
        height={grande ? 30 : 21}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* El boleto: rectángulo con la muesca del resguardo. */}
        <path d="M4 7.2A2.2 2.2 0 0 1 6.2 5H20v5.4a2.6 2.6 0 0 0 0 3.2V19H6.2A2.2 2.2 0 0 1 4 16.8z" />
        {/* La línea de perforación. */}
        <path d="M15.6 5.6v12.8" strokeDasharray="2 2.4" />
        {/* El número del turno. */}
        <path d="M7.4 10.2h5M7.4 13.4h3.4" />
      </svg>
    </div>
  )
}

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
    ? 'bg-peligro-50 text-peligro-700'
    : preferente
      ? 'bg-alerta-50 text-alerta-700'
      : 'bg-institucional-100 text-institucional-600'
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
    neutro: 'bg-institucional-100 text-institucional-700',
    ok: 'bg-ok-50 text-ok-700',
    alerta: 'bg-alerta-50 text-alerta-700',
    peligro: 'bg-peligro-50 text-peligro-700',
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
      {icono && <div className="text-institucional-300">{icono}</div>}
      <p className="text-sm font-semibold text-institucional-700">{titulo}</p>
      {detalle && <p className="max-w-sm text-sm text-institucional-400">{detalle}</p>}
    </div>
  )
}

/** Aviso en línea (errores de una operación, confirmaciones). */
export function Aviso({ tono, children }: {
  tono: 'ok' | 'alerta' | 'peligro'
  children: ReactNode
}) {
  const tonos = {
    ok: 'border-ok-500/30 bg-ok-50 text-ok-700',
    alerta: 'border-alerta-500/30 bg-alerta-50 text-alerta-700',
    peligro: 'border-peligro-500/30 bg-peligro-50 text-peligro-700',
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
        onCerrar()
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
  }, [onCerrar])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-institucional-900/50 p-0 sm:items-center sm:p-4"
      onClick={onCerrar}
      role="presentation"
    >
      <div
        ref={refDialog}
        className={`w-full ${ancho} rounded-t-2xl bg-white shadow-xl sm:rounded-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
      >
        <div className="flex items-center justify-between border-b border-institucional-100 px-5 py-4">
          <h2 className="text-base font-bold text-institucional-800">{titulo}</h2>
          <button
            type="button"
            onClick={onCerrar}
            className="rounded-lg p-1.5 text-institucional-400 transition-colors hover:bg-institucional-50 hover:text-institucional-700"
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
export function Campo({ etiqueta, children, ayuda }: {
  etiqueta: string
  children: ReactNode
  ayuda?: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-institucional-500">
        {etiqueta}
      </span>
      {children}
      {ayuda && <span className="mt-1 block text-xs text-institucional-400">{ayuda}</span>}
    </label>
  )
}
