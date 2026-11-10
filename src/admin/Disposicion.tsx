import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'

/**
 * Marco del panel administrativo.
 *
 * La consola se opera en ventanilla, a veces de pie y con poca luz: por eso
 * el menú es grande, el texto tiene cuerpo y el contenido no se esconde en
 * submenús.
 */
/*
 * `soloAdmin` marca las secciones que un agente NO debe ver.
 *
 * El menú se filtra con esto y no con una lista aparte: si una sección nueva
 * es de administración, basta añadir la marca aquí y desaparece sola para los
 * agentes. Ocultar es solo la mitad: la RLS y las funciones de la base son las
 * que de verdad impiden que un agente lea o cambie lo que no le toca. El menú
 * existe para no ofrecer puertas que no se abren.
 */
const SECCIONES = [
  { a: '/admin/turnos', txt: 'Turnos', icono: IconoTurnos, soloAdmin: false },
  { a: '/admin/usuarios', txt: 'Usuarios', icono: IconoUsuarios, soloAdmin: true },
  { a: '/admin/catalogos', txt: 'Catálogos', icono: IconoCatalogos, soloAdmin: true },
  { a: '/admin/historial', txt: 'Historial', icono: IconoHistorial, soloAdmin: false },
  { a: '/admin/estadisticas', txt: 'Estadísticas', icono: IconoEstadisticas, soloAdmin: false },
]

/**
 * Menú con deslizador de cristal.
 *
 * Adaptación del patrón «glass radio group» a navegación por rutas. El
 * original usa radios con `:checked ~ .glass-glider` para mover el brillo; aquí
 * no hay radios que marcar, así que el deslizador se posiciona con un índice
 * calculado y `transform: translateY(índice * 100%)`.
 *
 * Por qué no usar los radios igual:
 *
 *   - Un radio marca una opción de un formulario; aquí se navega. Un lector de
 *     pantalla anunciaría «Turnos, botón de opción, marcado», que describe mal
 *     lo que pasa. `aria-current="page"` es lo correcto para una navegación.
 *   - Con radios, el foco de teclado se movería con las flechas dentro del
 *     grupo; en un menú se espera Tab entre enlaces.
 *
 * La animación se conserva entera: mismo easing con rebote, mismo degradado,
 * mismo halo.
 */
function MenuCristal({
  secciones,
  onNavegar,
  colapsado,
}: {
  secciones: typeof SECCIONES
  onNavegar: () => void
  colapsado: boolean
}) {
  const { pathname } = useLocation()
  const indice = Math.max(0, secciones.findIndex((s) => pathname.startsWith(s.a)))

  /*
   * DE DÓNDE VIENE EL DESLIZADOR, no dónde está.
   *
   * Aquí es donde se rompía la animación. Al cambiar de ruta, `Disposicion`
   * vuelve a renderizar y crea un array de secciones nuevo; ese cambio de
   * identidad hacía que este menú se remontara. Un nodo recién montado ya
   * nace en su `translateY` final, y una transición no se dispara si el valor
   * no cambia después del montaje: por eso saltaba de golpe.
   *
   * Se guarda el índice anterior y se pinta primero en él; un frame después se
   * pasa al nuevo y la transición sí corre. Si el índice no cambió, no hay
   * nada que animar.
   */
  const anterior = useRef(indice)
  const [posicion, setPosicion] = useState(anterior.current)

  useEffect(() => {
    if (posicion === indice) return
    const t = requestAnimationFrame(() => setPosicion(indice))
    anterior.current = indice
    return () => cancelAnimationFrame(t)
  }, [indice, posicion])

  return (
    <div className="glass-menu">
      {/*
        El deslizador va primero y debajo en z-index: los enlaces quedan
        encima, así el texto nunca lo tapa ni recibe el clic. `aria-hidden`
        porque es decoración pura.
      */}
      <div
        className="glass-menu-glider"
        style={{ transform: `translateY(${posicion * 100}%)` }}
        aria-hidden="true"
      />
      {secciones.map(({ a, txt, icono: Icono }) => {
        const activo = pathname.startsWith(a)
        return (
          <NavLink
            key={a}
            to={a}
            onClick={onNavegar}
            aria-current={activo ? 'page' : undefined}
            aria-label={colapsado ? txt : undefined}
            title={colapsado ? txt : undefined}
            className={`glass-menu-item ${activo ? 'is-activo' : ''} ${
              colapsado ? 'lg:justify-center lg:gap-0 lg:px-0' : ''
            }`}
          >
            <span
              className={`transition-transform duration-300 ${
                colapsado ? 'lg:scale-110' : ''
              }`}
            >
              <Icono />
            </span>
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${
                colapsado
                  ? 'lg:max-w-0 lg:opacity-0'
                  : 'lg:max-w-xs lg:opacity-100'
              }`}
            >
              {txt}
            </span>
          </NavLink>
        )
      })}
    </div>
  )
}

/**
 * Lo que se ve mientras llega el chunk de la pantalla.
 *
 * Es un esqueleto, no un «Cargando…» centrado: así el hueco tiene la forma del
 * contenido y no hay salto cuando aparece. Dura pocos milisegundos, pero es
 * justo el instante en que antes se veía la pantalla anterior.
 */
function CargandoPantalla() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando pantalla…</span>
      <div aria-hidden="true" className="tarjeta p-6">
        <div className="esqueleto-bloque mb-4 h-4 w-40 rounded" />
        <div className="esqueleto-bloque mb-2 h-5 w-2/3 rounded" />
        <div className="esqueleto-bloque h-5 w-1/2 rounded" />
      </div>
      <div aria-hidden="true" className="tarjeta p-6">
        <div className="esqueleto-bloque mb-4 h-4 w-32 rounded" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="esqueleto-bloque mb-2 h-4 rounded" style={{ width: `${100 - (i % 3) * 9}%` }} />
        ))}
      </div>
    </div>
  )
}

export default function Disposicion({
  titulo,
  children,
}: {
  /** Si se omite, se toma de la sección activa (uso como contenedor de ruta). */
  titulo?: string
  children?: ReactNode
}) {
  const { operador, salir, esAdministrador } = useAuth()

  /*
   * Las secciones que este usuario puede ver, memorizadas.
   *
   * Sin `useMemo`, `.filter()` devuelve un array nuevo en cada render y el
   * menú se remonta: se perdería la posición del deslizador (y con ella la
   * animación) cada vez que cambia cualquier cosa en la pantalla.
   */
  const visibles = useMemo(
    () => SECCIONES.filter((s) => !s.soloAdmin || esAdministrador),
    [esAdministrador],
  )
  const navegar = useNavigate()
  const [abierto, setAbierto] = useState(false)
  /** Menú colapsado a solo-iconos (persistente, solo aplica en lg+). */
  const [colapsado, setColapsado] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('situr-menu-colapsado') === '1'
  })

  useEffect(() => {
    localStorage.setItem('situr-menu-colapsado', colapsado ? '1' : '0')
  }, [colapsado])
  /**
   * La ruta actual, como `key` del contenido.
   *
   * Sin esto, React reutiliza los nodos entre pantallas y la animación de
   * entrada solo se vería la primera vez: los elementos ya existen, así que
   * el navegador no vuelve a ejecutar la animación. Con la ruta como clave,
   * cada pantalla es un árbol nuevo y la animación corre en cada cambio.
   */
  const { pathname } = useLocation()

  /*
   * El título sale de la ruta cuando el layout se usa como contenedor.
   *
   * Así el <aside> y el <header> NO se desmontan al cambiar de pantalla: solo
   * cambia lo de dentro del <main>. Antes cada página montaba su propio
   * `Disposicion`, de modo que navegar destruía y recreaba la barra entera —
   * y con ella el menú, que por eso nunca alcanzaba a animar su deslizador.
   */
  const tituloActual =
    titulo ?? visibles.find((s) => pathname.startsWith(s.a))?.txt ?? 'Panel'

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
        } w-full shrink-0 bg-navy-800 text-gris-100 transition-[width] duration-300 ease-in-out lg:sticky lg:top-0 lg:block lg:h-screen ${
          colapsado ? 'lg:w-20' : 'lg:w-72'
        }`}
      >
        <div className="flex h-full flex-col">
          <div
            className={`border-b border-white/10 px-5 py-4 ${
              colapsado ? 'lg:px-2 lg:py-3' : ''
            }`}
          >
            <div
              className={`flex items-center gap-2 ${
                colapsado ? 'lg:justify-center' : 'justify-between'
              }`}
            >
              <div className={`min-w-0 flex-1 ${colapsado ? 'lg:hidden' : ''}`}>
                <p className="text-sm font-bold leading-snug text-white">
                  Sistema de toma de turnos
                </p>
                <p className="mt-0.5 truncate text-[11px] text-gris-200">
                  Dirección de Catastro
                </p>
              </div>
              <button
                type="button"
                onClick={() => setColapsado((v) => !v)}
                className="hidden rounded-lg p-1.5 text-gris-200 transition-colors hover:bg-white/10 hover:text-white lg:block"
                aria-label={colapsado ? 'Expandir menú' : 'Colapsar menú'}
                title={colapsado ? 'Expandir menú' : 'Colapsar menú'}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {colapsado ? (
                    <path d="m9 18 6-6-6-6" />
                  ) : (
                    <path d="m15 18-6-6 6-6" />
                  )}
                </svg>
              </button>
            </div>
          </div>

          <nav
            className={`flex-1 overflow-y-auto p-3 ${
              colapsado ? 'lg:p-2' : ''
            }`}
          >
            <MenuCristal
              secciones={visibles}
              onNavegar={() => setAbierto(false)}
              colapsado={colapsado}
            />
          </nav>

          <div
            className={`border-t border-white/10 p-3 ${
              colapsado ? 'lg:p-2' : ''
            }`}
          >
            <div className={`px-3 py-2 ${colapsado ? 'lg:hidden' : ''}`}>
              <p className="truncate text-sm font-semibold text-white">
                {operador?.nombres ?? 'Operador'}
              </p>
              <p className="truncate text-[11px] text-gris-200">
                {operador?.numero_empleado}
                {operador?.modulo ? ` · Módulo ${operador.modulo}` : ''}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-gris-200">
                {esAdministrador ? 'Administrador' : operador?.rol ?? 'Operador'}
              </p>
            </div>
            <button
              type="button"
              onClick={cerrarSesion}
              aria-label={colapsado ? 'Cerrar sesión' : undefined}
              title={colapsado ? 'Cerrar sesión' : undefined}
              className={`mt-1 flex w-full items-center rounded-lg text-sm font-semibold text-gris-200 transition-colors hover:bg-white/10 hover:text-white ${
                colapsado
                  ? 'lg:justify-center lg:gap-0 lg:px-0 lg:py-2.5'
                  : 'gap-3 px-3 py-2.5'
              }`}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5M21 12H9" />
              </svg>
              <span className={colapsado ? 'lg:hidden' : ''}>Cerrar sesión</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Contenido */}
      <div className="min-w-0 flex-1">
        {/*
          Cabecera en navy OPACO, no translúcida.

          Con el fondo plateado claro, un `bg-navy-900/70` dejaba pasar la
          plata y el título blanco caía a 1.82:1. El velo translúcido funciona
          sobre un fondo oscuro, pero aquí el fondo es claro: la transparencia
          lo aclara y se come el contraste. Opaco, el navy se mantiene y el
          blanco vuelve a leerse.

          El `backdrop-blur` se queda: sirve para el contenido que pasa por
          debajo al hacer scroll, aunque el relleno ya no sea translúcido.
        */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/10 bg-navy-900 px-4 py-3 backdrop-blur-md lg:px-8">
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            className="rounded-lg p-2 text-gris-200 hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Abrir menú"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <h1 className="truncate text-lg font-bold text-white">{tituloActual}</h1>
        </header>
        {/*
          El `Suspense` va AQUÍ DENTRO y no envolviendo todo el layout.
          Las pantallas se cargan con `lazy`, así que al cambiar de sección el
          chunk de la nueva aún no está. Con el `Suspense` por fuera, React
          suspendía el árbol entero y dejaba a la vista la pantalla ANTERIOR
          durante un instante: se veía «Turnos» con el menú ya marcando
          «Estadísticas». Acotándolo al `main`, lo de arriba (barra lateral y
          cabecera) nunca se suspende y el contenido muestra su esqueleto.
        */}
        <main key={pathname} className="entrada-escalonada p-4 lg:p-8">
          <Suspense fallback={<CargandoPantalla />}>{children ?? <Outlet />}</Suspense>
        </main>
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
