import { useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Marca } from '../components/ui'

/**
 * Marco del panel administrativo.
 *
 * La consola se opera en ventanilla, a veces de pie y con poca luz: por eso
 * el menú es grande, el texto tiene cuerpo y el contenido no se esconde en
 * submenús.
 */
const SECCIONES = [
  { a: '/admin/turnos', txt: 'Turnos', icono: IconoTurnos },
  { a: '/admin/usuarios', txt: 'Usuarios', icono: IconoUsuarios },
  { a: '/admin/catalogos', txt: 'Catálogos', icono: IconoCatalogos },
  { a: '/admin/historial', txt: 'Historial', icono: IconoHistorial },
  { a: '/admin/estadisticas', txt: 'Estadísticas', icono: IconoEstadisticas },
]

export default function Disposicion({
  titulo,
  children,
}: {
  titulo: string
  children: ReactNode
}) {
  const { operador, salir, esAdministrador } = useAuth()
  const navegar = useNavigate()
  const [abierto, setAbierto] = useState(false)

  async function cerrarSesion() {
    await salir()
    navegar('/admin')
  }

  return (
    <div className="min-h-screen lg:flex">
      {/* Barra lateral */}
      <aside
        className={`${
          abierto ? 'block' : 'hidden'
        } w-full shrink-0 bg-institucional-800 text-institucional-100 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-72`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
            <Marca />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-white">SITUR</p>
              <p className="truncate text-[11px] text-institucional-200">
                Dirección de Catastro
              </p>
            </div>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto p-3">
            {SECCIONES.map(({ a, txt, icono: Icono }) => (
              <NavLink
                key={a}
                to={a}
                onClick={() => setAbierto(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
                    isActive
                      ? 'bg-institucional-600 text-white'
                      : 'text-institucional-200 hover:bg-white/10 hover:text-white'
                  }`
                }
              >
                <Icono />
                {txt}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-white/10 p-3">
            <div className="px-3 py-2">
              <p className="truncate text-sm font-semibold text-white">
                {operador?.nombres ?? 'Operador'}
              </p>
              <p className="truncate text-[11px] text-institucional-200">
                {operador?.numero_empleado}
                {operador?.modulo ? ` · Módulo ${operador.modulo}` : ''}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-institucional-200">
                {esAdministrador ? 'Administrador' : operador?.rol ?? 'Operador'}
              </p>
            </div>
            <button
              type="button"
              onClick={cerrarSesion}
              className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-institucional-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5M21 12H9" />
              </svg>
              Cerrar sesión
            </button>
          </div>
        </div>
      </aside>

      {/* Contenido */}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-institucional-100 bg-white/90 px-4 py-3 backdrop-blur lg:px-8">
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            className="rounded-lg p-2 text-institucional-500 hover:bg-institucional-50 lg:hidden"
            aria-label="Abrir menú"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <h1 className="truncate text-lg font-bold text-institucional-800">{titulo}</h1>
        </header>
        <main className="p-4 lg:p-8">{children}</main>
      </div>
    </div>
  )
}

const svg = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function IconoTurnos() {
  return (
    <svg {...svg}>
      <path d="M3 6h18M3 12h18M3 18h12" />
    </svg>
  )
}
function IconoUsuarios() {
  return (
    <svg {...svg}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    </svg>
  )
}
function IconoCatalogos() {
  return (
    <svg {...svg}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function IconoHistorial() {
  return (
    <svg {...svg}>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}
function IconoEstadisticas() {
  return (
    <svg {...svg}>
      <path d="M3 3v18h18" />
      <path d="M7 16v-4M12 16V8M17 16v-6" />
    </svg>
  )
}
