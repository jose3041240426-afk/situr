import { useCallback, useEffect, useState } from 'react'
import {
  listarCola,
} from '../lib/rpc'
import type { FilaCola } from '../lib/tipos'
import { Esqueleto } from '../components/ui'
import CodigoQR from '../components/CodigoQR'

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
  const sinHeader = !titulo && !icono && !badge
  return (
    <section className={`recepcion-tarjeta${sinHeader ? ' recepcion-tarjeta-sin-redondeo-arriba' : ''}`}>
      {!sinHeader && (
        <div className="recepcion-tarjeta-header">
          <div className="flex items-center gap-2.5">
            <span className="recepcion-icono">{icono}</span>
            <h2 className="recepcion-tarjeta-titulo">{titulo}</h2>
          </div>
          {badge && <div>{badge}</div>}
        </div>
      )}
      <div className={sinHeader ? 'recepcion-tarjeta-cuerpo' : 'recepcion-tarjeta-cuerpo'}>
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

      {/* Resumen rápido — En espera (ajustado al contenido) */}
      <div className="mb-4">
        <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-1.5 flex items-center gap-3 w-fit">
          <div className="flex items-center gap-2 text-gris-300">
            <IconoCola />
            <span className="text-xs font-medium">En espera</span>
          </div>
          <p className="text-2xl font-black text-white tabular-nums">{totalEnCola}</p>
        </div>
      </div>

      {/* Layout: izquierda (cola) + derecha (QR centrado en espacio libre) */}
      <div className="flex gap-4">
        {/* IZQUIERDA — Cola de espera (dos columnas de 5) */}
        <div className="flex flex-col">
          {/* Título superior — cubre ambos contenedores */}
          <div className="rounded-t-xl bg-white border border-b-0 border-slate-200 px-4 py-2 text-center" style={{ width: '696px' }}>
            <p className="text-sm font-bold text-slate-700">Turnos a continuación</p>
          </div>
          <div className="flex gap-4 mt-3">
          {/* PRIMERA MITAD — primeros 5 */}
          <div style={{ width: '340px', flexShrink: 0 }}>
            <TarjetaSeccion
              titulo=""
              icono={null}
            >
              {!listo ? (
                <Esqueleto filas={5} />
              ) : cola.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <IconoVacio />
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    No hay turnos en espera.
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Los turnos emitidos aparecerán aquí.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {cola.slice(0, 5).map((t) => (
                    <div
                      key={t.turno_id}
                      className="flex items-center justify-between rounded-lg border-[3px] border-blue-500 bg-white px-0 py-0 overflow-hidden transition-colors hover:bg-slate-50"
                    >
                      <div className="min-w-0 px-4 py-3 flex-1">
                        <p className="text-lg font-black tracking-wide text-slate-900 tabular-nums">{t.codigo_turno}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {t.clave_tramite} — {t.denominacion_tramite}
                        </p>
                      </div>
                      <div className="ml-0 flex items-center justify-center h-full px-3 bg-blue-50 rounded-r-lg">
                        <span className="text-lg font-black text-blue-600 tabular-nums">
                          {t.posicion}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TarjetaSeccion>
          </div>

          {/* SEGUNDA MITAD — siguientes 5 */}
          <div style={{ width: '340px', flexShrink: 0 }}>
            <TarjetaSeccion
              titulo=""
              icono={null}
            >
              {!listo ? (
                <Esqueleto filas={5} />
              ) : cola.length <= 5 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <IconoVacio />
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    Sin turnos adicionales.
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Aparecerán cuando haya más de 5.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {cola.slice(5, 10).map((t) => (
                    <div
                      key={t.turno_id}
                      className="flex items-center justify-between rounded-lg border-[3px] border-blue-500 bg-white px-0 py-0 overflow-hidden transition-colors hover:bg-slate-50"
                    >
                      <div className="min-w-0 px-4 py-3 flex-1">
                        <p className="text-lg font-black tracking-wide text-slate-900 tabular-nums">{t.codigo_turno}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {t.clave_tramite} — {t.denominacion_tramite}
                        </p>
                      </div>
                      <div className="ml-0 flex items-center justify-center h-full px-3 bg-blue-50 rounded-r-lg">
                        <span className="text-lg font-black text-blue-600 tabular-nums">
                          {t.posicion}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TarjetaSeccion>
          </div>
          </div>
        </div>

        {/* DERECHA — espacio libre con QR centrado */}
        <div className="flex-1 flex flex-col items-center justify-start">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <CodigoQR valor={`${window.location.origin}/turno/R-006`} tamano={200} />
          </div>
          <div className="mt-4 text-center">
            <p className="text-3xl font-black tracking-wide text-white tabular-nums">R-006</p>
            <p className="mt-1 text-sm text-gris-300">Registro catastral</p>
          </div>
        </div>
      </div>

      {/* Nota informativa */}
      <p className="mt-4 text-center text-xs font-bold text-gris-300">
        Si tu turno no aparece, es porque está más abajo en la cola. En un momento será visible aquí.
      </p>
    </div>
  )
}
