import { useEffect, useState } from 'react'
import { listarUltimasLlamadas } from '../lib/rpc'
import type { UltimaLlamada } from '../lib/tipos'

/**
 * SITUR — Pantalla pública (RF-020). OPCIONAL (DRS §5.1).
 *
 * Muestra las últimas llamadas: folio → módulo. **Sin datos personales.**
 *
 * No es un requisito: si la empresa no pone un televisor de apoyo, esta
 * pantalla simplemente no se enciende y nada más cambia. Ni una tabla, ni una
 * RPC, ni una política se modifican por ello — la TV es un consumidor más de
 * la misma vista pública que ya usa el ciudadano.
 *
 * El diseño es de sala de espera: tipografía grande, alto contraste, visto
 * desde dos o tres metros. Por eso los tamaños no son los de una pantalla de
 * escritorio: el código del turno va a 72 px, que es lo que se lee a tres
 * metros, y el reloj a 36.
 */
export default function PantallaPublica() {
  const [turnos, setTurnos] = useState<UltimaLlamada[]>([])
  const [reloj, setReloj] = useState(new Date())

  useEffect(() => {
    /*
     * La carga es INMEDIATA y luego cada 5 s. Con solo un `setInterval` la
     * pantalla se quedaba en blanco los primeros cinco segundos cada vez
     * que se encendía: en una sala de espera eso es una pantalla muerta
     * delante de la gente, y un salto de cinco segundos en el turno llamado.
     */
    const cargar = () => {
      void listarUltimasLlamadas(8)
        .then(setTurnos)
        .catch(() => undefined)
    }
    cargar()
    const t = setInterval(cargar, 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const t = setInterval(() => setReloj(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // La RPC ya devuelve solo las llamadas, de la más reciente a la más
  // antigua: no hay nada que filtrar aquí.
  const masRecientes = turnos

  return (
    <div className="flex min-h-screen flex-col bg-navy-900 text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-8 py-5">
        <div>
          <p className="text-3xl font-black">SITUR</p>
          <p className="text-base text-gris-200">Dirección de Catastro · Durango</p>
        </div>
        {/*
          El reloj va en la tipografia del sistema, no en una monoespaciada.
          Las cifras siguen sin moverse (`tabular-nums`), que es lo que se
          quiere de un reloj, pero el aparato se ve de la misma familia que
          todo lo demas: una monoespaciada de sistema es una maquina de
          escribir al lado de un cartel.
        */}
        <p className="text-4xl font-bold tabular-nums text-gris-200">
          {reloj.toLocaleTimeString('es-MX', {
            timeZone: 'America/Mazatlan',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      </header>

      <main className="flex-1 px-8 py-6">
        <h1 className="mb-4 text-base font-bold uppercase tracking-widest text-gris-200">
          Últimas llamadas
        </h1>

        {masRecientes.length === 0 ? (
          <p className="text-3xl text-gris-200">
            Espere a que se llamen los turnos.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {masRecientes.map((t) => (
              <li
                key={`${t.codigo_turno}-${t.llamado_en}`}
                className="rounded-2xl border border-white/10 bg-white/5 p-6"
              >
                <p className="text-7xl font-black leading-none">{t.codigo_turno}</p>
                <p className="mt-3 text-2xl font-bold text-gris-200">
                  Módulo {t.codigo_modulo ?? '—'}
                </p>
                <p className="mt-1 text-base text-gris-200">
                  {t.denominacion_tramite}
                </p>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="border-t border-white/10 px-8 py-4 text-center text-base text-gris-200">
        Consulte su turno con el código QR que le entregamos.
      </footer>
    </div>
  )
}
