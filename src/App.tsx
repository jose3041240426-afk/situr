import { Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ProveedorAuth } from './lib/auth'
import { hayConfiguracion } from './lib/supabase'
import { useTitulo } from './lib/useTitulo'
import Entrar from './admin/Entrar'
import { Aviso } from './components/ui'

/**
 * SITUR — Enrutado.
 *
 * La primera superficie: el acceso del operador. Todo lo demás entra
 * después.
 */
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
      <Suspense fallback={<Cargando />}>
        <Routes>
          <Route path="/" element={<Navigate to="/admin" replace />} />
          <Route path="/admin" element={<Entrar />} />
          <Route path="*" element={<NoEncontrado />} />
        </Routes>
      </Suspense>
    </ProveedorAuth>
  )
}

function Cargando() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-institucional-500">Cargando…</p>
    </div>
  )
}

function NoEncontrado() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-4xl font-black text-institucional-200">404</p>
      <h1 className="text-lg font-bold text-institucional-700">Esta página no existe</h1>
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
  switch (ruta) {
    case '/admin':
      return 'Acceso'
    default:
      return null
  }
}
