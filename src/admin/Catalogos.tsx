import { useCallback, useEffect, useState } from 'react'
import Disposicion from './Disposicion'
import { Aviso, Chip, Vacio } from '../components/ui'
import { ErrorSitur, listarModulos, listarTramites } from '../lib/rpc'
import type { Modulo, Tramite } from '../lib/tipos'
import { ETIQUETA_ESTADO_MODULO } from '../lib/tipos'
import { useAuth } from '../lib/auth'

/**
 * SITUR — Catálogos: trámites y módulos (RF-023).
 *
 * Se muestran en solo lectura. La escritura la hace la base a través de las
 * políticas RLS de administrador, y el DDL no expone RPC para darla de alta:
 * un cambio de catálogo es una operación de configuración, no de ventanilla.
 */
export default function Catalogos() {
  const { esAdministrador } = useAuth()
  const [tramites, setTramites] = useState<Tramite[]>([])
  const [modulos, setModulos] = useState<Modulo[]>([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'peligro'; texto: string } | null>(null)

  const cargar = useCallback(async () => {
    try {
      const [ts, ms] = await Promise.all([listarTramites(false), listarModulos()])
      setTramites(ts)
      setModulos(ms)
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudieron cargar los catálogos.',
      })
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  return (
    <Disposicion titulo="Catálogos">
      {aviso && (
        <div className="mb-4">
          <Aviso tono={aviso.tono}>{aviso.texto}</Aviso>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="tarjeta overflow-hidden">
          <div className="border-b border-institucional-100 px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
              Trámites
            </h2>
            <p className="mt-0.5 text-xs text-institucional-400">
              El prefijo es único en toda la base: es lo que impide que el código
              visible <code className="font-mono">A-001</code> se repita entre dos
              trámites distintos.
            </p>
          </div>
          {cargando ? (
            <Vacio titulo="Cargando…" />
          ) : (
            <ul className="divide-y divide-institucional-100">
              {tramites.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-institucional-800">{t.denominacion}</p>
                    <p className="font-mono text-xs text-institucional-400">
                      {t.clave} · prefijo {t.prefijo}
                      {t.tiempo_estimado_minutos != null
                        ? ` · ${t.tiempo_estimado_minutos} min`
                        : ''}
                    </p>
                  </div>
                  {t.activo ? <Chip tono="ok">Activo</Chip> : <Chip tono="neutro">Inactivo</Chip>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="tarjeta overflow-hidden">
          <div className="border-b border-institucional-100 px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
              Módulos
            </h2>
            <p className="mt-0.5 text-xs text-institucional-400">
              «estado» es la disponibilidad operativa (RN-013) y «activo» la
              habilitación administrativa: son cosas distintas.
            </p>
          </div>
          {cargando ? (
            <Vacio titulo="Cargando…" />
          ) : (
            <ul className="divide-y divide-institucional-100">
              {modulos.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-institucional-800">
                      {m.codigo} — {m.denominacion}
                    </p>
                  </div>
                  <Chip tono={m.estado === 'ACTIVO' ? 'ok' : m.estado === 'PAUSADO' ? 'alerta' : 'peligro'}>
                    {ETIQUETA_ESTADO_MODULO[m.estado]}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {!esAdministrador && (
        <p className="mt-4 text-xs text-institucional-400">
          Está viendo los catálogos en modo lectura. Solo el administrador puede
          modificarlos.
        </p>
      )}
    </Disposicion>
  )
}
