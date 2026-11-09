/**
 * Marca de disponibilidad de un turno.
 *
 * QUÉ PROBLEMA RESUELVE
 * Cuando se emite un lote, salen decenas de papeles idénticos en `WAITING`.
 * En recepción alguien llega con un papel y hay que saber rápido:
 *
 *   ¿este turno ya tiene dueño, o todavía nadie lo tomó?
 *
 * No interesa QUIÉN lo tiene (el asesor fue explícito: solo si está tomado).
 * Con dos estados basta.
 *
 * DE DÓNDE SALE EL DATO
 * No es un campo nuevo ni una marca manual: el estado del turno ya lo dice.
 *
 *   WAITING                  → sin dueño  → «Disponible»
 *   CALLED / SERVING / FINALIZADO / CANCELLED → con dueño → «Con dueño»
 *
 * Un turno que ya fue llamado tiene `atendido_por`; uno que nunca se llamó no
 * lo tiene. Así que la marca nunca miente y no hace falta migración, ni una
 * tabla nueva, ni un botón que alguien pueda olvidar pulsar.
 *
 * POR QUÉ UNA CASILLA Y NO SOLO COLOR
 * La diferencia debe entenderse sin distinguir colores (WCAG 1.4.1): casilla
 * marcada / casilla vacía es la señal principal; el color solo refuerza.
 */

type Props = {
  /** `true` cuando el turno ya salió de `WAITING` (alguien lo tiene). */
  conDueno: boolean
  /** Nombre de quien lo atiende, si se conoce. */
  quien?: string | null
  /** Compacta: solo la casilla y la palabra, para tablas densas. */
  compacta?: boolean
}

export default function MarcaDisponible({ conDueno, quien, compacta = false }: Props) {
  if (compacta) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
          conDueno ? 'text-ambar-600' : 'text-verde-600'
        }`}
        title={
          conDueno
            ? `Este turno ya tiene dueño${quien ? `: ${quien}` : ''}`
            : 'Este turno todavía no lo ha tomado nadie'
        }
      >
        <Casilla marcada={conDueno} />
        {conDueno ? 'Con dueño' : 'Disponible'}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-semibold ${
        conDueno ? 'bg-ambar-50 text-ambar-600' : 'bg-verde-50 text-verde-600'
      }`}
    >
      <Casilla marcada={conDueno} />
      {conDueno ? 'Con dueño' : 'Disponible'}
    </span>
  )
}

/**
 * La casilla.
 *
 * Se dibuja con CSS y no con una imagen para que herede el color del texto
 * (ámbar o verde) y no haya que mantener dos archivos.
 */
function Casilla({ marcada }: { marcada: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-2 ${
        marcada ? 'border-current' : 'border-current bg-transparent'
      }`}
    >
      {/* La palomita solo existe cuando está marcada. Con `aria-hidden` arriba,
          el lector de pantalla se apoya en el texto «Con dueño» / «Disponible»
          que va al lado, que ya lo dice sin ambigüedad. */}
      {marcada && (
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none">
          <path
            d="M2 6.2 4.6 8.8 10 3.4"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  )
}
