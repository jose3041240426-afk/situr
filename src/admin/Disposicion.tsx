import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { nombreCompleto } from '../lib/operador'
import { Modal } from '../components/ui'
import { Avatar } from '../components/ui/avatar'
import EsqueletoPantalla from './Esqueletos'

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
  /*
   * «Mi perfil» va el último y NO lleva `soloAdmin`: la ficha de la cuenta
   * es de todo operador, y hasta de uno que no pueda operar. Es la pantalla
   * que dice quién eres y qué rango tienes.
   */
  { a: '/admin/perfil', txt: 'Mi perfil', icono: IconoPerfil, soloAdmin: false },
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
  /**
   * El diálogo de confirmación de salida.
   *
   * «Cerrar sesión» estaba al pie de la barra, pegado a la navegación: un
   * clic de más al ir a pulsar «Historial» y el operador se quedaba fuera,
   * teniendo que volver a entrar con MFA. No se pierde nada —los turnos
   * están en la base— pero cortar el trabajo en ventanilla por un roce sí
   * tiene coste, y es de las pocas acciones que no se pueden deshacer con
   * otro clic.
   */
  const [confirmandoSalida, setConfirmandoSalida] = useState(false)
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

  /*
   * El contenido de la ruta, memorizado.
   *
   * `colapsado` vive en este componente, así que plegar el menú lo volvía a
   * renderizar TODO, incluida la página de dentro: la consola con su tabla de
   * turnos, las cifras y los modales. Eso era el tirón que se notaba al
   * plegar y desplegar.
   *
   * Memorizado por `pathname`, React reutiliza el mismo elemento y no vuelve a
   * renderizar la pantalla: el cambio de ancho queda en un layout, no en un
   * render de React más un layout. Al cambiar de ruta el elemento es nuevo y
   * la pantalla se pinta como siempre.
   */
  const contenido = useMemo(() => children ?? <Outlet />, [children, pathname])

  /*
   * El acomodo de la barra al plegarla o desplegarla.
   *
   * El ancho cambia de una vez —animarlo reflowaba la tabla de turnos en cada
   * fotograma: medido, 11 fotogramas de hasta 133 ms— y lo que se anima es el
   * contenido de la propia barra, que son 288 px y no la página entera.
   *
   * `yaCambiado` evita la animación de la primera pintura: si el usuario entra
   * con el menú plegado, no debe verlo entrar deslizándose.
   */
  const [yaCambiado, setYaCambiado] = useState(false)
  const primerRender = useRef(true)
  useEffect(() => {
    if (primerRender.current) {
      primerRender.current = false
      return
    }
    setYaCambiado(true)
  }, [colapsado])

  return (
    <div className="min-h-screen lg:flex">
      {/*
        Barra lateral.

        El ancho se anima con `transition-[width]`, pero solo ahora que el
        contenido de la ruta está memorizado (ver `contenido`): antes cada
        fotograma re-renderizaba React la consola entera —tabla de turnos,
        cifras, modales— y además reflowaba, y eso era el tirón. Sin ese
        re-render, la transición cuesta un layout por fotograma y se ve fluida.

        `motion-safe:` respeta `prefers-reduced-motion`: quien pida menos
        movimiento no ve la animación, solo el cambio de ancho.
      */}
      <aside
        data-animar={yaCambiado ? 'si' : 'no'}
        data-plegado={colapsado ? 'si' : 'no'}
        className={`${
          abierto ? 'block' : 'hidden'
        } w-full shrink-0 bg-navy-800 text-gris-100 lg:sticky lg:top-0 lg:block lg:h-screen ${
          colapsado ? 'lg:w-20' : 'lg:w-72'
        }`}
      >
        <div className="barra-animada flex h-full flex-col">
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
                {/*
                  Un solo icono para los dos estados: la barra lateral con su
                  panel. Antes eran dos flechas (‹ y ›) dibujadas a mano, y al
                  cambiar de estado el botón parecía otro botón.
                */}
                <span
                  className={`text-lg ${
                    colapsado
                      ? 'andrsrxn--panel-right-open-filled'
                      : 'cuida--sidebar-collapse-outline'
                  }`}
                  aria-hidden="true"
                />
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
            {/*
              Quién ha iniciado sesión.

              Antes eran tres líneas: el nombre, «EMP-0001 · Módulo M01» y el
              rol en mayúsculas. El número de empleado no le dice nada al
              operador (es un dato de nómina, no de la ventanilla) y el rol
              repetía el nombre cuando la cuenta se llama justamente
              «Administrador».

              Ahora el icono del rol va ENCIMA del nombre y centrado, como la
              cabecera de una ficha: escudo para administración, persona para
              el operador. Debajo, el nombre y el módulo, que sí importa porque
              decide qué trámites se atienden.

              El rol no se pierde para lectores de pantalla: va en el `title`
              del icono y en un `sr-only` junto al nombre.
            */}
            <div
              className={`mb-3 flex flex-col items-center gap-1 rounded-xl bg-white/[0.07] px-3 py-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_18px_-10px_rgba(0,0,0,0.9)] ${
                colapsado ? 'lg:hidden' : ''
              }`}
            >
              {/*
                El rol va en el NOMBRE ACCESIBLE del icono, no en un `sr-only`
                al lado del nombre.

                Antes era un `sr-only` dentro del párrafo blanco: el texto no
                se ve, pero hereda el `color` del párrafo y el escáner de
                contraste lo mide igual (1.33:1 sobre la barra). Un falso
                positivo que aparecía en las seis pantallas del panel.

                Con `role="img"` y `aria-label` el lector de pantalla anuncia
                «Administrador, imagen» antes del nombre, y no hay texto que
                medir.
              */}
              <span
                role="img"
                aria-label={esAdministrador ? 'Administrador' : (operador?.rol ?? 'Operador')}
                className={`text-xl text-gris-200 ${
                  esAdministrador ? 'eos-icons--admin' : 'at-icons--person'
                }`}
                title={esAdministrador ? 'Administrador' : (operador?.rol ?? 'Operador')}
              />
              <div className="min-w-0 max-w-full">
                <p className="truncate text-sm font-semibold text-white">
                  {operador?.nombres ?? 'Operador'}
                </p>
                {operador?.modulo && (
                  <p className="truncate text-[11px] text-gris-200">
                    Módulo {operador.modulo}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfirmandoSalida(true)}
              aria-label={colapsado ? 'Cerrar sesión' : undefined}
              title={colapsado ? 'Cerrar sesión' : undefined}
              className={`boton-salir ${colapsado ? 'boton-salir--compacto' : ''}`}
            >
              {/*
                Icono con máscara y texto aparte: el hover del botón (el mismo
                que «Emitir turno») mueve el icono al centro y desvanece el
                texto, y eso necesita que el icono sea su propia capa.
              */}
              <span
                className="boton-salir-icono basil--logout-solid"
                aria-hidden="true"
              />
              <span className={`boton-salir-texto ${colapsado ? 'lg:hidden' : ''}`}>
                Cerrar sesión
              </span>
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

          {/*
            EL ROSTRO DE LA CUENTA, en la cabecera.

            Es el avatar que sustituye a la foto de perfil: se dibuja en el
            navegador a partir del nombre, así que no hay imagen que cargar ni
            que pueda fallar. Va a la derecha porque ahí es donde se mira para
            saber con qué cuenta se está operando, y lleva a la ficha.

            El nombre va oculto en móvil: con la pantalla estrecha solo cabe
            el rostro, y el texto se leería cortado.
          */}
          {operador && (
            <NavLink
              to="/admin/perfil"
              /*
                El nombre accesible tiene que CONTENER el texto visible
                (WCAG 2.5.3). Con `aria-label="Mi perfil"` y el nombre del
                operador a la vista, el lector de pantalla anunciaba «Mi
                perfil» y el operador veía «Prueba»: el control y lo que
                dice no coincidían.
              */}
              aria-label={`Mi perfil de ${operador.nombres}`}
              title="Mi perfil"
              className="ml-auto flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul-300"
            >
              <Avatar
                nombre={nombreCompleto(operador)}
                tamano="sm"
                etiqueta={`Avatar de ${nombreCompleto(operador)}`}
              />
              <span className="hidden max-w-40 truncate text-sm font-semibold text-white lg:block">
                {operador.nombres}
              </span>
            </NavLink>
          )}
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
          <Suspense fallback={<EsqueletoPantalla ruta={pathname} />}>
            {contenido}
          </Suspense>
        </main>
      </div>

      {/*
        CONFIRMACIÓN DE SALIDA.

        Misma tarjeta que el resto de los avisos de la consola (icono en
        círculo, una frase, dos botones), adaptada al azul del sistema en vez
        del morado del ejemplo original: aquí el color no decora, dice qué
        botón es el principal.

        El botón de cancelar va primero en el DOM para que el foco inicial del
        diálogo caiga en la opción que no hace nada.
      */}
      {confirmandoSalida && (
        <Modal
          titulo="Cerrar sesión"
          ancho="max-w-sm"
          onCerrar={() => setConfirmandoSalida(false)}
        >
          <div className="text-center">
            <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-azul-50 text-azul-600">
              <span className="basil--logout-solid text-2xl" aria-hidden="true" />
            </span>
            <p className="text-2xl font-black tracking-tight text-navy-800">
              ¿Seguro que quiere salir?
            </p>
            <p className="mx-auto mt-2 max-w-xs text-sm text-gris-700">
              Se cierra la sesión en este equipo. No se pierde nada: los turnos
              siguen guardados y al volver a entrar la consola los encuentra
              igual.
            </p>

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                className="boton-secundario"
                onClick={() => setConfirmandoSalida(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="boton-primario"
                onClick={() => {
                  setConfirmandoSalida(false)
                  void cerrarSesion()
                }}
              >
                Cerrar sesión
              </button>
            </div>
          </div>
        </Modal>
      )}
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
/*
 * La ficha de la cuenta. Es un carné: el marco es la tarjeta y el círculo es
 * el rostro, con las dos líneas de los datos.
 */
function IconoPerfil() {
  return (
    <svg {...svg}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <circle cx="8.5" cy="10" r="2.2" />
      <path d="M5 16.5c.6-1.6 1.9-2.4 3.5-2.4s2.9.8 3.5 2.4" />
      <path d="M15 9.5h4M15 13h4" />
    </svg>
  )
}
