import { useCallback, useEffect, useState } from 'react'
import { colaEnVivo, ultimoTurnoEmitido, tokenTurnoParaQr } from '../lib/rpc'
import type { FilaColaVivo, UltimoTurnoEmitido } from '../lib/rpc'
import { Esqueleto } from '../components/ui'
import CodigoQR from '../components/CodigoQR'

/**
 * SITUR — Turnos en vivo (RECEPCIÓN).
 *
 * Pantalla independiente que el personal deja abierta en un monitor pegado a
 * la ventanilla. Tiene dos mitades y cada una responde a una persona distinta:
 *
 *   - La cola, para quien YA tiene papel: en qué orden llegó la gente. El
 *     número que se ve es la posición POR LLEGADA, que es la que entiende el
 *     ciudadano («usted es el 4 de los que han llegado»). El folio no sirve
 *     para eso: cada trámite lleva su propio contador, así que «G-0001» y
 *     «A-002» no son comparables entre sí.
 *   - El QR grande, para quien ACABA de llegar: escanea el papel que trae y ve
 *     su turno en el teléfono. Por eso el QR es del ÚLTIMO turno emitido y no
 *     del siguiente de la fila: quien llega a escanear es quien acaba de
 *     recibir su papel en la ventanilla.
 *
 * Se actualiza cada 5 segundos. El orden de la cola lo pone la base
 * (`cola_en_vivo`), no esta pantalla.
 */

const C = {
  bg: '#071A3D',
  navy: '#0B2A5B',
  blue700: '#1D4ED8',
  blue600: '#2563EB',
  blue500: '#3B82F6',
  blue400: '#60A5FA',
  blue200: '#BFDBFE',
  blue100: '#DBEAFE',
  muted: '#9DB8E3',
  glass: 'rgba(255,255,255,0.06)',
  glassLine: 'rgba(147,197,253,0.18)',
}

const font = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif'

/**
 * Cuántos turnos caben en la cola sin que el monitor tenga que hacer scroll.
 *
 * La pantalla no se desplaza a propósito: está en un monitor fijo y un scroll
 * escondería turnos sin que nadie lo note. Con dos columnas de cinco, diez
 * caben con holgura en 768 px de alto.
 */
const VISIBLES = 10

/**
 * Ticket individual — glass por defecto, gradiente azul si es el siguiente.
 *
 * El número grande es la posición POR LLEGADA. Con la prioridad de un turno
 * marcado a mano, el orden real de llamada puede adelantar a alguien: por eso
 * el ticket que va a ser llamado primero lleva el distintivo «SIGUIENTE»
 * aunque no sea el primero de la lista.
 *
 * Es un `<button>`: se puede pulsar con el ratón y también con el teclado
 * (Enter o Espacio), que es como lo usa quien está en la ventanilla con las
 * manos ocupadas.
 */
function Ticket({
  t,
  siguiente,
  elegido,
  onElegir,
}: {
  t: FilaColaVivo
  siguiente?: boolean
  elegido?: boolean
  onElegir: (t: FilaColaVivo) => void
}) {
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [])

  return (
    <button
      type="button"
      onClick={() => onElegir(t)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        toggleFullscreen()
      }}
      aria-pressed={elegido}
      aria-label={`Ver el código de ${t.codigo_turno}, ${t.denominacion_tramite}`}
      title={`Doble clic para pantalla completa`}
      className="relative flex items-center overflow-hidden rounded-3xl text-left transition-transform"
      style={{
        height: 80,
        gap: 16,
        padding: '0 20px 0 16px',
        background: siguiente
          ? `linear-gradient(120deg, ${C.blue600}, ${C.blue700})`
          : elegido
            ? 'rgba(96,165,250,0.22)'
            : C.glass,
        border: siguiente
          ? `2px solid ${C.blue400}`
          : elegido
            ? `2px solid ${C.blue400}`
            : `1px solid ${C.glassLine}`,
        boxShadow: siguiente
          ? '0 0 40px rgba(59,130,246,0.4)'
          : elegido
            ? '0 0 24px rgba(59,130,246,0.28)'
            : 'none',
        fontFamily: font,
        cursor: 'pointer',
      }}
    >
      {/* Número de posición por llegada */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          background: siguiente ? '#fff' : 'rgba(59,130,246,0.18)',
          color: siguiente ? C.blue700 : C.blue200,
          fontSize: 20,
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {t.posicion_llegada}
      </div>

      {/* Info del turno */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: '#fff',
            lineHeight: 1.1,
            letterSpacing: 0.5,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {t.codigo_turno}
        </div>
        <div
          style={{
            fontSize: 12,
            color: siguiente ? C.blue100 : C.muted,
            marginTop: 4,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.clave_tramite} — {t.denominacion_tramite}
        </div>
        {/*
          La hora va debajo del trámite: dice lo que el código no dice (quién
          llegó antes) sin competir por el espacio con el distintivo.
        */}
        <div
          style={{
            fontSize: 11,
            color: siguiente ? C.blue100 : 'rgba(157,184,227,0.65)',
            marginTop: 2,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
          title="Hora de emisión del turno"
        >
          {horaDe(t.creado_en)}
        </div>
      </div>

      {/*
        El distintivo va en la esquina superior derecha. La hora ya no está
        ahí, así que no se tapan.
      */}
      {siguiente && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 14,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.5,
            color: C.blue700,
            background: '#fff',
            padding: '4px 12px',
            borderRadius: 999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          SIGUIENTE
        </div>
      )}
    </button>
  )
}

/** Hora local en formato corto: «1:58 p.m.». */
function horaDe(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function TurnosVivos() {
  const [filas, setFilas] = useState<FilaColaVivo[]>([])
  const [total, setTotal] = useState(0)
  const [ultimo, setUltimo] = useState<UltimoTurnoEmitido | null>(null)
  const [listo, setListo] = useState(false)

  /*
   * El turno que se está mostrando en el panel del QR.
   *
   * `null` significa «el último emitido», que es el que se ofrece por
   * defecto: quien acaba de recibir su papel en la ventanilla escanea ese.
   * Al pulsar un turno de la lista, pasa a mostrarse ese.
   */
  const [elegido, setElegido] = useState<FilaColaVivo | null>(null)
  const [tokenElegido, setTokenElegido] = useState<string | null>(null)
  const [pidiendoToken, setPidiendoToken] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const [cola, ultimoTurno] = await Promise.all([colaEnVivo(VISIBLES), ultimoTurnoEmitido()])
      setFilas(cola.filas)
      setTotal(cola.total)
      setUltimo(ultimoTurno)
      setListo(true)
    } catch (err) {
      console.error('TurnosVivos: error al cargar', err)
    }
  }, [])

  useEffect(() => {
    void cargar()
    const id = setInterval(cargar, 5_000)
    return () => clearInterval(id)
  }, [cargar])

  /*
   * Pulsa un turno de la lista: el panel del QR pasa a mostrar ese.
   *
   * El token se pide en ese momento y no al cargar la cola: pedir el token de
   * las diez filas visibles serían diez consultas para algo que solo se usa
   * cuando alguien pulsa. Aquí es una, y solo cuando pulsa.
   */
  const elegirTurno = useCallback(async (t: FilaColaVivo) => {
    setElegido(t)
    setPidiendoToken(true)
    try {
      const { token_publico } = await tokenTurnoParaQr(t.turno_id)
      setTokenElegido(token_publico)
    } catch (err) {
      console.error('TurnosVivos: no se pudo obtener el token', err)
      setTokenElegido(null)
    } finally {
      setPidiendoToken(false)
    }
  }, [])

  /*
   * El que va a ser llamado primero no siempre es el primero que llegó: un
   * turno con prioridad marcada a mano se adelanta (RN-017). La base ya lo
   * calculó (`posicion_global`), así que aquí solo se busca cuál es.
   */
  const idSiguiente = filas.find((f) => f.posicion_global === 1)?.turno_id ?? null

  /*
   * Lo que se ve en el panel: el turno elegido, o el último emitido si no
   * se ha elegido ninguno. El QR usa el token del elegido; el código y el
   * nombre del trámite, los de ese mismo turno.
   */
  const enPanel = elegido
    ? {
        codigo_turno: elegido.codigo_turno,
        denominacion_tramite: elegido.denominacion_tramite,
        token: tokenElegido,
      }
    : {
        codigo_turno: ultimo?.codigo_turno ?? '',
        denominacion_tramite: ultimo?.denominacion_tramite ?? '',
        token: ultimo?.token_publico ?? null,
      }

  const hayAlgo = Boolean(enPanel.codigo_turno)

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: `radial-gradient(1200px 700px at 88% 8%, rgba(59,130,246,0.30), transparent 60%), radial-gradient(900px 600px at 0% 100%, rgba(37,99,235,0.22), transparent 60%), ${C.bg}`,
        fontFamily: font,
        color: '#fff',
        padding: '0 40px',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between" style={{ height: 100, flexShrink: 0 }}>
        <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1 }}>Turnos en vivo</div>

        {/* Badge En espera — glass */}
        <div
          className="flex items-center gap-3"
          style={{
            padding: '14px 24px',
            borderRadius: 20,
            background: C.glass,
            border: `1px solid ${C.glassLine}`,
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke={C.blue400}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <div style={{ fontSize: 16, color: C.muted, fontWeight: 600 }}>En espera</div>
          <div
            style={{
              fontSize: 40,
              fontWeight: 800,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {total}
          </div>
        </div>
      </div>

      {/* Main: cola + QR */}
      <div className="flex-1 flex min-h-0 gap-6" style={{ flex: 1 }}>
        {/* COLA — contenedor glass */}
        <div
          className="flex-1 flex flex-col rounded-3xl p-5 gap-4"
          style={{ background: C.glass, border: `1px solid ${C.glassLine}` }}
        >
          <div className="flex items-center justify-between px-2">
            <div style={{ fontSize: 22, fontWeight: 700 }}>Turnos a continuación</div>
            <div style={{ fontSize: 14, color: C.muted, fontWeight: 600 }}>
              {total > 0 ? `Próximos ${Math.min(total, VISIBLES)} de ${total}` : 'Sin turnos en espera'}
            </div>
          </div>

          {!listo ? (
            <Esqueleto filas={5} />
          ) : filas.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
              <svg
                className="w-16 h-16 text-slate-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="mt-3 text-sm font-medium" style={{ color: C.muted }}>
                No hay turnos en espera.
              </p>
              <p className="mt-1 text-xs" style={{ color: 'rgba(157,184,227,0.5)' }}>
                Los turnos emitidos aparecerán aquí.
              </p>
            </div>
          ) : (
            <div
              className="flex-1"
              style={{
                display: 'grid',
                /*
                 * Se llena por FILAS, no por columnas: el turno 2 va a la
                 * derecha del 1, no debajo. La cola se lee de izquierda a
                 * derecha, y con las columnas el público leía 1, 4, 2, 5, 3.
                 */
                gridAutoFlow: 'row',
                gridTemplateColumns: '1fr 1fr',
                gridTemplateRows: `repeat(${Math.ceil(filas.length / 2)}, 80px)`,
                gap: 12,
                columnGap: 14,
                alignContent: 'start',
              }}
            >
              {filas.map((t) => (
                <Ticket
                  key={t.turno_id}
                  t={t}
                  siguiente={t.turno_id === idSiguiente}
                  elegido={t.turno_id === elegido?.turno_id}
                  onElegir={elegirTurno}
                />
              ))}
            </div>
          )}
        </div>

        {/* QR — lado derecho */}
        <div
          className="flex flex-col items-center justify-center gap-4"
          style={{ width: 340, flexShrink: 0 }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 3,
              color: C.blue200,
              textAlign: 'center',
            }}
          >
            ESCANEA TU TURNO
          </div>

          {listo && !hayAlgo ? (
            /*
             * Sin turnos emitidos todavía no hay nada que escanear. Se dice con
             * palabras en vez de pintar un QR vacío, que parecería roto.
             */
            <div
              className="flex flex-col items-center justify-center text-center"
              style={{
                width: 280,
                height: 280,
                borderRadius: 28,
                border: `2px dashed ${C.glassLine}`,
                color: C.muted,
                fontSize: 15,
                fontWeight: 600,
                padding: 24,
                lineHeight: 1.5,
              }}
            >
              Aún no se ha emitido ningún turno en este periodo.
            </div>
          ) : (
            <div
              style={{
                background: '#fff',
                padding: 20,
                borderRadius: 28,
                boxShadow:
                  '0 24px 60px rgba(0,0,0,0.45), 0 0 0 8px rgba(96,165,250,0.15)',
              }}
            >
              {enPanel.token ? (
                <CodigoQR
                  valor={`${window.location.origin}/turno/${enPanel.token}`}
                  tamano={240}
                />
              ) : (
                /* Mientras llega el token, el hueco mide lo mismo que el QR:
                   así el panel no salta cuando aparece. */
                <div
                  className="animate-pulse"
                  style={{ width: 240, height: 240, borderRadius: 8, background: '#e2e8f0' }}
                />
              )}
            </div>
          )}

          <div
            style={{
              fontSize: 56,
              fontWeight: 800,
              lineHeight: 1,
              marginTop: 4,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {enPanel.codigo_turno || '—'}
          </div>
          <div
            style={{
              fontSize: 18,
              color: C.blue200,
              fontWeight: 500,
              textAlign: 'center',
              maxWidth: 320,
            }}
          >
            {enPanel.denominacion_tramite || 'Sin turnos emitidos'}
          </div>

          {/*
            Cuando hay un turno elegido, se dice cuál es y se ofrece volver al
            último emitido. Sin esto, quien Mire la pantalla no sabe si el QR
            es del último papel o del que alguien tocó hace un momento.
          */}
          {elegido && (
            <div
              className="flex flex-col items-center gap-2"
              style={{ marginTop: 2, textAlign: 'center' }}
            >
              <div style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>
                Mostrando el código de {elegido.codigo_turno}
              </div>
              <button
                type="button"
                onClick={() => {
                  setElegido(null)
                  setTokenElegido(null)
                }}
                style={{
                  background: 'rgba(255,255,255,0.12)',
                  border: `1px solid ${C.glassLine}`,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  padding: '6px 14px',
                  borderRadius: 999,
                  cursor: 'pointer',
                }}
              >
                Volver al último emitido
              </button>
            </div>
          )}

          {pidiendoToken && (
            <div style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>
              Buscando el código…
            </div>
          )}

          {/* Leyenda de escaneo */}
          <div
            className="flex flex-col items-center gap-2"
            style={{
              marginTop: 6,
              background: '#fff',
              color: C.blue700,
              padding: '14px 20px',
              borderRadius: 18,
              fontSize: 14,
              fontWeight: 700,
              lineHeight: 1.35,
              maxWidth: 300,
              textAlign: 'center',
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke={C.blue600}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
            Escanea el código de tu turno para seguirlo en tu teléfono
          </div>

          {/*
            El aviso de que se puede elegir un turno va junto al QR, que es
            donde está el panel. La lista de la izquierda es la que se toca.
          */}
          <div
            style={{
              fontSize: 12,
              color: C.muted,
              fontWeight: 600,
              textAlign: 'center',
              maxWidth: 300,
              lineHeight: 1.4,
            }}
          >
            Pulsa un turno de la lista para mostrar aquí su código.
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-center gap-3"
        style={{
          height: 50,
          flexShrink: 0,
          fontSize: 14,
          color: C.muted,
          fontWeight: 500,
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        Si tu turno no aparece en la lista, es porque aún está más abajo en la cola. En un momento será visible aquí.
      </div>
    </div>
  )
}
