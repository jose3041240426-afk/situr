import { useCallback, useEffect, useState } from 'react'
import Disposicion from './Disposicion'
import { Aviso, Campo, Chip, Modal, Vacio } from '../components/ui'
import { ErrorSitur, asignarModuloUsuario, listarModulos, listarUsuarios } from '../lib/rpc'
import type { Modulo, Usuario } from '../lib/tipos'
import { useAuth } from '../lib/auth'

/**
 * SITUR — Usuarios (RF-003).
 *
 * El alta de un usuario NO se hace desde aquí: Supabase Auth vive fuera de
 * esta base y es la única fuente de la sesión. Lo que sí se hace aquí es lo
 * que la base controla: el módulo que opera cada persona (RG-004) y su
 * estado.
 *
 * RF-003: "No se borra físicamente si hay historial" — por eso la gestión es
 * desactivar, nunca eliminar.
 */
export default function GestionUsuarios() {
  const { esAdministrador } = useAuth()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [modulos, setModulos] = useState<Modulo[]>([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'peligro'; texto: string } | null>(null)
  const [editando, setEditando] = useState<Usuario | null>(null)

  const cargar = useCallback(async () => {
    try {
      const [us, ms] = await Promise.all([listarUsuarios(), listarModulos()])
      setUsuarios(us)
      setModulos(ms)
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudieron cargar los usuarios.',
      })
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  async function asignar(usuario: Usuario, moduloId: string | null) {
    setAviso(null)
    try {
      const r = await asignarModuloUsuario(usuario.id, moduloId)
      if (!r.ok) {
        setAviso({ tono: 'peligro', texto: r.error })
        return
      }
      setAviso({ tono: 'ok', texto: `Módulo actualizado para ${usuario.numero_empleado}.` })
      await cargar()
      setEditando(null)
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo asignar el módulo.',
      })
    }
  }

  return (
    <Disposicion titulo="Usuarios">
      {aviso && (
        <div className="mb-4">
          <Aviso tono={aviso.tono}>{aviso.texto}</Aviso>
        </div>
      )}

      {!esAdministrador ? (
        <Aviso tono="alerta">Solo los administradores pueden ver la lista completa de usuarios.</Aviso>
      ) : (
        <section className="tarjeta overflow-hidden">
          <div className="flex items-center justify-between border-b border-institucional-100 px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
              Personal con acceso
            </h2>
            <span className="text-xs text-institucional-400">{usuarios.length}</span>
          </div>

          {cargando ? (
            <Vacio titulo="Cargando…" />
          ) : usuarios.length === 0 ? (
            <Vacio
              titulo="Sin usuarios registrados"
              detalle="Las cuentas se crean en Supabase Auth y se enlazan aquí con su auth_uid."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-institucional-50 text-left text-xs text-institucional-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Empleado</th>
                    <th className="px-3 py-2 font-medium">Nombre</th>
                    <th className="px-3 py-2 font-medium">Rol</th>
                    <th className="px-3 py-2 font-medium">Módulo</th>
                    <th className="px-3 py-2 font-medium">MFA</th>
                    <th className="px-3 py-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-institucional-100">
                  {usuarios.map((u) => (
                    <tr key={u.id} className="hover:bg-institucional-50">
                      <td className="px-4 py-2.5 font-mono text-xs text-institucional-600">
                        {u.numero_empleado}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-institucional-800">
                          {u.nombres} {u.apellido_paterno}
                        </span>
                        <br />
                        <span className="text-xs text-institucional-400">{u.email}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Chip>{u.rol_clave}</Chip>
                      </td>
                      <td className="px-4 py-2.5">
                        {u.modulo_codigo ? (
                          <Chip tono="ok">{u.modulo_codigo}</Chip>
                        ) : (
                          <span className="text-xs text-institucional-300">sin módulo</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {u.mfa_habilitado ? (
                          <Chip tono="ok">Activo</Chip>
                        ) : (
                          <Chip tono="alerta">Pendiente</Chip>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => setEditando(u)}
                          className="boton-secundario px-3 py-1.5 text-xs"
                        >
                          Asignar módulo
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {editando && (
        <Modal
          titulo={`Módulo de ${editando.numero_empleado}`}
          onCerrar={() => setEditando(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-institucional-500">
              El módulo define a dónde se enrutan los turnos cuando esta persona
              pulsa «llamar siguiente» (RG-004). Si el módulo está pausado, la base
              elige otro activo.
            </p>
            <Campo etiqueta="Módulo">
              <select
                id="modio-usuario"
                className="selector"
                defaultValue={editando.modulo_codigo ?? ''}
              >
                <option value="">Sin módulo (elige el primero activo)</option>
                {modulos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.codigo} — {m.denominacion}
                    {m.estado !== 'ACTIVO' ? ` (${m.estado})` : ''}
                  </option>
                ))}
              </select>
            </Campo>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditando(null)} className="boton-secundario">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  const valor = (document.getElementById('modio-usuario') as HTMLSelectElement).value
                  void asignar(editando, valor || null)
                }}
                className="boton-primario"
              >
                Guardar
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Disposicion>
  )
}
