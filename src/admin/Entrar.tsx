import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { Aviso, Campo, Marca } from '../components/ui'

/**
 * SITUR — Acceso del operador.
 *
 * RF-001: solo usuarios administrativos registrados.
 * RF-026: la inscripción de MFA es obligatoria en el primer acceso. Si la
 * cuenta ya tiene MFA, Supabase pide el segundo factor al entrar; si no lo
 * tiene, la pantalla de aquí ofrece inscribirlo antes de dejarle operar.
 */
export default function Entrar() {
  const { sesion, operador, mfaPendiente, cargando, entrar, error: errorAuth } = useAuth()
  const navegar = useNavigate()

  const [correo, setCorreo] = useState('')
  const [clave, setClave] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  useEffect(() => {
    if (sesion && operador && !mfaPendiente) {
      navegar('/admin/turnos', { replace: true })
    }
  }, [sesion, operador, mfaPendiente, navegar])

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setEnviando(true)
    try {
      await entrar(correo.trim(), clave)
    } catch {
      // el error ya quedó en el contexto
    } finally {
      setEnviando(false)
    }
  }

  if (cargando) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-institucional-200">Cargando…</p>
      </div>
    )
  }

  if (sesion && operador && mfaPendiente) {
    return <InscripcionMFA />
  }

  return (
    // `main` como landmark: sin él, el contenido del login no está dentro de
    // ninguna región (WCAG 1.3.1) y un lector de pantalla no puede saltar
    // al contenido.
    <main className="flex min-h-screen items-center justify-center bg-institucional-800 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3">
            <Marca tamano="lg" />
          </div>
          <h1 className="text-2xl font-black text-white">SITUR</h1>
          <p className="mt-1 text-sm text-institucional-200">
            Sistema de Gestión y Seguimiento de Turnos
          </p>
          <p className="text-xs text-institucional-200">Dirección de Catastro · Durango</p>
        </div>

        <form onSubmit={enviar} className="tarjeta space-y-4 p-6">
          <Campo etiqueta="Correo institucional">
            <input
              type="email"
              required
              autoComplete="username"
              className="campo"
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              placeholder="nombre@catastro.durango.gob.mx"
            />
          </Campo>

          <Campo etiqueta="Contraseña">
            <input
              type="password"
              required
              autoComplete="current-password"
              className="campo"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
            />
          </Campo>

          {(error ?? errorAuth) && <Aviso tono="peligro">{error ?? errorAuth}</Aviso>}

          <button type="submit" disabled={enviando} className="boton-primario w-full">
            {enviando ? 'Entrando…' : 'Entrar'}
          </button>

          <p className="text-center text-xs text-institucional-500">
            Acceso restringido a personal autorizado (RF-001).
          </p>
        </form>
      </div>
    </main>
  )
}

/**
 * Inscripción de MFA (RF-026): sin MFA configurado no se habilitan las
 * funciones privilegiadas. Supabase enrola con TOTP; el código se confirma
 * desde la app autenticadora del operador.
 */
function InscripcionMFA() {
  const { operador, salir, recargar } = useAuth()
  const [qr, setQr] = useState<string | null>(null)
  const [secreto, setSecreto] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [codigo, setCodigo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [listo, setListo] = useState(false)

  async function enrollar() {
    setError(null)
    const { data, error: err } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'SITUR',
    })
    if (err || !data) {
      setError(err?.message ?? 'No se pudo iniciar la inscripción.')
      return
    }
    setQr(data.totp.qr_code)
    setSecreto(data.totp.secret)
    setFactorId(data.id)
  }

  async function confirmar(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setError(null)
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: codigo.trim(),
    })
    if (err) {
      setError(err.message)
      return
    }
    setListo(true)
    await recargar()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-institucional-800 p-4">
      <div className="w-full max-w-md">
        <div className="tarjeta p-6">
          <h1 className="text-lg font-bold text-institucional-800">
            Active la verificación en dos pasos
          </h1>
          <p className="mt-1 text-sm text-institucional-500">
            {operador?.nombres}, su cuenta todavía no tiene MFA. Es obligatorio en el
            primer acceso (RF-026); con ello, las funciones privilegiadas quedan
            habilitadas.
          </p>

          {listo ? (
            <div className="mt-5 space-y-4">
              <Aviso tono="ok">MFA configurado. Ya puede operar.</Aviso>
              <a href="/admin/turnos" className="boton-primario w-full">
                Ir a la consola
              </a>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {error && <Aviso tono="peligro">{error}</Aviso>}

              {!qr ? (
                <button type="button" onClick={enrollar} className="boton-primario w-full">
                  Configurar ahora
                </button>
              ) : (
                <form onSubmit={confirmar} className="space-y-4">
                  <div className="rounded-lg border border-institucional-100 bg-institucional-50 p-4 text-center">
                    {qr && (
                      <img
                        src={qr}
                        alt="Código QR para la aplicación autenticadora"
                        className="mx-auto h-48 w-48"
                      />
                    )}
                  </div>
                  {secreto && (
                    <p className="break-all rounded-lg bg-institucional-50 px-3 py-2 font-mono text-xs text-institucional-600">
                      {secreto}
                    </p>
                  )}
                  <Campo etiqueta="Código de 6 dígitos" ayuda="El que muestra su aplicación autenticadora.">
                    <input
                      inputMode="numeric"
                      required
                      pattern="[0-9]{6}"
                      maxLength={6}
                      className="campo text-center text-lg tracking-[0.3em]"
                      value={codigo}
                      onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
                    />
                  </Campo>
                  <button type="submit" className="boton-primario w-full">
                    Verificar y continuar
                  </button>
                </form>
              )}

              <button type="button" onClick={salir} className="w-full text-center text-xs text-institucional-200 hover:text-institucional-100">
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
