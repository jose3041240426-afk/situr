import { useCallback, useEffect, useState } from 'react'
import { listarCola } from '../lib/rpc'
import type { FilaCola } from '../lib/tipos'
import { Esqueleto } from '../components/ui'
import CodigoQR from '../components/CodigoQR'

/**
 * SITUR — Turnos en vivo (RECEPCIÓN).
 * Pantalla independiente con diseño glass y gradientes.
 * Se actualiza cada 5 segundos automáticamente.
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
 * Ticket individual — glass por defecto, gradiente azul si es el primero
 */
function Ticket({ t, first }: { t: FilaCola; first?: boolean }) {
  return (
    <div
      className="relative flex items-center overflow-hidden rounded-3xl transition-colors"
      style={{
        height: 80,
        gap: 16,
        padding: '0 20px 0 16px',
        background: first
          ? `linear-gradient(120deg, ${C.blue600}, ${C.blue700})`
          : C.glass,
        border: first
          ? `2px solid ${C.blue400}`
          : `1px solid ${C.glassLine}`,
        boxShadow: first ? '0 0 40px rgba(59,130,246,0.4)' : 'none',
        fontFamily: font,
      }}
    >
      {/* Número de posición */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          background: first ? '#fff' : 'rgba(59,130,246,0.18)',
          color: first ? C.blue700 : C.blue200,
          fontSize: 22,
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {t.posicion}
      </div>

      {/* Info del turno */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: '#fff',
            lineHeight: 1.1,
            fontFamily: font,
          }}
        >
          {t.codigo_turno}
        </div>
        <div
          style={{
            fontSize: 12,
            color: first ? C.blue100 : C.muted,
            marginTop: 4,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontFamily: font,
          }}
        >
          {t.clave_tramite} — {t.denominacion_tramite}
        </div>
      </div>

      {/* Badge SIGUIENTE en el primero */}
      {first && (
        <div
          style={{
            position: 'absolute',
            top: -10,
            right: 14,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.5,
            color: C.blue700,
            background: '#fff',
            padding: '4px 12px',
            borderRadius: 999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            fontFamily: font,
          }}
        >
          SIGUIENTE
        </div>
      )}
    </div>
  )
}

export default function TurnosVivos() {
  const [cola, setCola] = useState<FilaCola[]>([])
  const [listo, setListo] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const c = await listarCola()
      setCola(c)
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

  const totalEnCola = cola.length
  const proximos10 = cola.slice(0, 10)

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
      <div
        className="flex items-center justify-between"
        style={{ height: 100, flexShrink: 0 }}
      >
        <div>
          <div
            className="flex items-center gap-2 mb-2"
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 3,
              color: C.blue200,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: C.blue400,
                boxShadow: '0 0 0 4px rgba(96,165,250,0.25)',
              }}
            />
            EN VIVO
          </div>
          <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1 }}>
            Turnos en vivo
          </div>
        </div>

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
          <div style={{ fontSize: 16, color: C.muted, fontWeight: 600 }}>
            En espera
          </div>
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1 }}>
            {totalEnCola}
          </div>
        </div>
      </div>

      {/* Main: cola + QR */}
      <div
        className="flex-1 flex min-h-0 gap-6"
        style={{ flex: 1 }}
      >
        {/* COLA — contenedor glass */}
        <div
          className="flex-1 flex flex-col rounded-3xl p-5 gap-4"
          style={{
            background: C.glass,
            border: `1px solid ${C.glassLine}`,
          }}
        >
          <div className="flex items-center justify-between px-2">
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              Turnos a continuación
            </div>
            <div style={{ fontSize: 14, color: C.muted, fontWeight: 600 }}>
              Próximos {Math.min(proximos10.length, 10)}
            </div>
          </div>

          {!listo ? (
            <Esqueleto filas={5} />
          ) : proximos10.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
              <svg className="w-16 h-16 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
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
                gridAutoFlow: 'column',
                gridTemplateColumns: '1fr 1fr',
                gridTemplateRows: `repeat(${Math.ceil(proximos10.length / 2)}, 80px)`,
                gap: 12,
                columnGap: 14,
                alignItems: 'start',
              }}
            >
              {proximos10.map((t, i) => (
                <Ticket key={t.turno_id} t={t} first={i === 0} />
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
            }}
          >
            SIGUIENTE TURNO
          </div>

          <div
            style={{
              background: '#fff',
              padding: 20,
              borderRadius: 28,
              boxShadow: '0 24px 60px rgba(0,0,0,0.45), 0 0 0 8px rgba(96,165,250,0.15)',
            }}
          >
            <CodigoQR
              valor={`${window.location.origin}/turno/R-006`}
              tamano={240}
            />
          </div>

          <div style={{ fontSize: 56, fontWeight: 800, lineHeight: 1, marginTop: 4 }}>
            R-006
          </div>
          <div style={{ fontSize: 18, color: C.blue200, fontWeight: 500 }}>
            Registro catastral
          </div>

          {/* Leyenda de escaneo */}
          <div
            className="flex items-start gap-3"
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
              style={{ flexShrink: 0 }}
            >
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
            Escanea tu código para estar al tanto de tu turno
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
          stroke={C.blue400}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        Si tu turno no aparece, es porque está más abajo en la cola. En un momento será visible aquí.
      </div>
    </div>
  )
}
