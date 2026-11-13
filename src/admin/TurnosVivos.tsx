import { useCallback, useEffect, useState } from 'react'
import {
  listarCola,
} from '../lib/rpc'
import type { FilaCola } from '../lib/tipos'
import { Esqueleto } from '../components/ui'

/**
 * SITUR — Turnos en vivo (RECEPCIÓN).
 *
 * Pantalla independiente que se abre en otra pestaña del navegador.
 * Muestra la cola de espera en tiempo real: los turnos emitidos aparecen
 * aquí con su código, trámite y posición en la cola.
 *
 * No requiere layout de Disposicion ni menú lateral: es una pantalla
 * limpia y autónoma que el personal de recepción puede dejar abierta
 * en un monitor secundario o ventana separada.
 *
 * Se actualiza cada 5 segundos automáticamente.
 */

/**
 * Icono SVG para cola de espera
 */
function IconoCola() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}


/**
 * Icono SVG para vacío
 */
function IconoVacio() {
  return (
    <svg className="w-16 h-16 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

/**
 * Chip de estado para RECEPCIÓN
 */
function ChipRecepcion({ texto, tono }: { texto: string; tono: 'verde' | 'azul' | 'gris' | 'amarillo' }) {
  const clases = {
    verde: 'bg-emerald-100 text-emerald-700 ring-emerald-600/20',
    azul: 'bg-blue-100 text-blue-700 ring-blue-600/20',
    gris: 'bg-slate-100 text-slate-600 ring-slate-500/10',
    amarillo: 'bg-amber-100 text-amber-700 ring-amber-600/20',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset ${clases[tono]}`}>
      {tono === 'verde' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
      {texto}
    </span>
  )
}

/**
 * Tarjeta de sección con estilo moderno
 */
function TarjetaSeccion({
  titulo,
  icono,
  badge,
  children,
}: {
  titulo: string
  icono: React.ReactNode
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="recepcion-tarjeta">
      <div className="recepcion-tarjeta-header">
        <div className="flex items-center gap-2.5">
          <span className="recepcion-icono">{icono}</span>
          <h2 className="recepcion-tarjeta-titulo">{titulo}</h2>
        </div>
        {badge && <div>{badge}</div>}
      </div>
      <div className="recepcion-tarjeta-cuerpo">
        {children}
      </div>
    </section>
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

  return (
    <div className="min-h-screen bg-navy-900 p-6">
      {/* Header */}
      <header className="mb-6">
        <h1 className="text-2xl font-black text-white">Turnos en vivo</h1>
      </header>

      {/* Resumen rápido */}
      <div className="mb-6">
        <div className="rounded-xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center gap-2 text-gris-300">
            <IconoCola />
            <span className="text-xs font-medium">En espera</span>
          </div>
          <p className="mt-1 text-4xl font-black text-white tabular-nums">{totalEnCola}</p>
        </div>
      </div>

      {/* Grid: Cola en mitad izquierda */}
      <div className="grid grid-cols-2 gap-6">
        {/* COLA DE ESPERA */}
        <TarjetaSeccion
          titulo="Cola de espera"
          icono={<IconoCola />}
          badge={
            <ChipRecepcion texto={`${totalEnCola} turnos`} tono={totalEnCola > 0 ? 'amarillo' : 'gris'} />
          }
        >
          {!listo ? (
            <Esqueleto filas={5} />
          ) : cola.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <IconoVacio />
              <p className="mt-3 text-sm font-medium text-slate-500">
                No hay turnos en espera.
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Los turnos emitidos aparecerán aquí.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-4" style={{
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(148,163,184,0.5) rgba(241,245,249,0.5)',
            }}>
              {cola.map((t) => (
                <div
                  key={t.turno_id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 border-l-4 border-l-amber-400 bg-white px-4 py-3 transition-colors hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="text-lg font-black tracking-wide text-slate-900 tabular-nums">{t.codigo_turno}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {t.clave_tramite} — {t.denominacion_tramite}
                    </p>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <span className="inline-flex items-center justify-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-black text-amber-700">
                      #{t.posicion}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TarjetaSeccion>

      </div>
    </div>
  )
}
