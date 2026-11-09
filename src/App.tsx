import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ProveedorAuth, useAuth } from './lib/auth'
import { hayConfiguracion } from './lib/supabase'
import { useTitulo } from './lib/useTitulo'
import Entrar from './admin/Entrar'
import Disposicion from './admin/Disposicion'
import FondoBloom from './components/FondoBloom'
import { Aviso } from './components/ui'

/**
 * SITUR — Enrutado.
 *
 * Tres superficies, separadas por completo (DRS §1):
 *
 *   /admin/*       Consola del operador. Requiere sesión de Supabase Auth.
 *   /turno/:token  Portal del ciudadano. Anónimo: solo su token.
 *   /pantalla      Pantalla pública. Opcional (DRS §5.1): sin televisor, la
 *                  sección se apaga sola y nada más cambia.
 *
 * El panel se carga bajo demanda: el ciudadano entra por el móvil, a veces con
 * mala conexión, y no tiene por qué descargar la consola de administración.
 */
const Consola = lazy(() => import('./admin/Consola'))
const GestionUsuarios = lazy(() => import('./admin/GestionUsuarios'))
const Catalogos = lazy(() => import('./admin/Catalogos'))
const Historial = lazy(() => import('./admin/Historial'))
const Estadisticas = lazy(() => import('./admin/Estadisticas'))
const TurnoCiudadano = lazy(() => import('./ciudadano/TurnoCiudadano'))
const PantallaPublica = lazy(() => import('./ciudadano/PantallaPublica'))

/**
 * SITUR — Enrutado.
 *
 * Tres superficies, separadas por completo (DRS §1):
 *
 *   /admin/*     Consola del operador. Requiere sesión de Supabase Auth.
 *   /turno/:token  Portal del ciudadano. Anónimo: solo su token.
 *   /pantalla    Pantalla pública. Opcional (DRS §5.1): sin televisor, la
 *                sección se apaga sola y nada más cambia.
 */
/**
 * Puerta de las secciones de administración.
 *
 * Ocultar el enlace del menú no alcanza: cualquiera escribe
 * /admin/usuarios a mano. Esto lo corta en el enrutador, antes de montar la
 * pantalla.
 *
 * No es la defensa real —esa está en la base, con RLS y funciones que
 * verifican el rol—; es para no mostrar una pantalla condenada a fallar con
 * un error crudo de Postgres.
 */
function SoloAdministrador({ children }: { children: ReactNode }) {
  const { cargando, esAdministrador } = useAuth()
  if (cargando) return <Cargando />
  return esAdministrador ? <>{children}</> : <Navigate to="/admin/turnos" replace />
}

/**
 * Puerta de las pantallas del panel: exige sesión.
 *
 * Va por separado de `SoloAdministrador` porque son cosas distintas — tener
 * sesión no es ser administrador. Aquí solo se comprueba que haya operador
 * con acceso; el rol lo mira la guarda de cada pantalla.
 */
function SoloOperador({ children }: { children: ReactNode }) {
  const { cargando, sesion } = useAuth()
  if (cargando) return <Cargando />
  return sesion ? <>{children}</> : <Navigate to="/admin" replace />
}

export default function App() {
  const { pathname } = useLocation()
  useTitulo(tituloDeRuta(pathname))

  if (!hayConfiguracion()) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-lg">
          <Aviso tono="peligro">
            <p className="font-bold">Falta la configuración de Supabase</p>
            <p className="mt-1 font-normal">
              Define <code className="font-mono">VITE_SUPABASE_URL</code> y{' '}
              <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> en el archivo{' '}
              <code className="font-mono">.env.local</code> (copia{' '}
              <code className="font-mono">.env.example</code>) y reinicia el servidor.
            </p>
          </Aviso>
        </div>
      </div>
    )
  }

  return (
    <ProveedorAuth>
      {/*
        El fondo va fuera del enrutador y no se remonta al cambiar de pantalla:
        el degradado sigue su animación sin saltar al navegar.
      */}
      <FondoBloom />
      {/*
        Sin `Suspense` envolviendo las rutas del panel: cada pantalla trae el
        suyo dentro del `main` (ver `Disposicion`). Con uno global, cambiar de
        sección congelaba el árbol completo y la pantalla anterior seguía a la
        vista mientras llegaba el chunk de la nueva.

        Aquí solo queda el de las rutas públicas, que no comparten layout y sí
        necesitan uno.
      */}
      <Suspense fallback={<Cargando />}>
        <Routes>
          <Route path="/" element={<Navigate to="/admin" replace />} />

          <Route path="/admin" element={<Entrar />} />

          {/*
            Las pantallas del panel van ANIDADAS bajo un único `Disposicion`.
            Si cada una montara el suyo, navegar destruiría y recrearía la
            barra lateral entera: el menú perdía su estado (y su animación) en
            cada cambio de pantalla, y además se repintaba de más.
          */}
          <Route element={<SoloOperador><Disposicion /></SoloOperador>}>
            <Route path="/admin/turnos" element={<Consola />} />
            <Route
              path="/admin/usuarios"
              element={
                <SoloAdministrador>
                  <GestionUsuarios />
                </SoloAdministrador>
              }
            />
            <Route
              path="/admin/catalogos"
              element={
                <SoloAdministrador>
                  <Catalogos />
                </SoloAdministrador>
              }
            />
            <Route path="/admin/historial" element={<Historial />} />
            <Route path="/admin/estadisticas" element={<Estadisticas />} />
          </Route>

          <Route path="/turno/:token" element={<TurnoCiudadano />} />
          <Route path="/pantalla" element={<PantallaPublica />} />

          <Route path="*" element={<NoEncontrado />} />
        </Routes>
      </Suspense>
    </ProveedorAuth>
  )
}

function Cargando() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-gris-500">Cargando…</p>
    </div>
  )
}

function NoEncontrado() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-4xl font-black text-gris-200">404</p>
      <h1 className="text-lg font-bold text-gris-700">Esta página no existe</h1>
      <a href="/admin" className="boton-secundario">
        Ir al panel
      </a>
    </div>
  )
}

/**
 * El título de cada pantalla (WCAG 2.4.2). Un lector de pantalla y el
 * historial de pestañas necesitan distinguir una pantalla de otra.
 */
function tituloDeRuta(ruta: string): string | null {
  if (ruta.startsWith('/turno/')) return 'Su turno'
  switch (ruta) {
    case '/admin':
      return 'Acceso'
    case '/admin/turnos':
      return 'Turnos'
    case '/admin/usuarios':
      return 'Usuarios'
    case '/admin/catalogos':
      return 'Catálogos'
    case '/admin/historial':
      return 'Historial'
    case '/admin/estadisticas':
      return 'Estadísticas'
    case '/pantalla':
      return 'Pantalla de llamadas'
    default:
      return null
  }
}
