import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { marcarMfaHabilitado } from '../lib/rpc'
import { Aviso } from '../components/ui'
import Acceso from '../components/ui/auth-form-1'
import { OtpInput, type OtpStatus } from '../components/ui/otp-input'

/**
 * SITUR — Acceso del operador.
 *
 * RF-001: solo usuarios administrativos registrados.
 * RF-026: la inscripción de MFA es obligatoria en el primer acceso. Si la
 * cuenta ya tiene MFA, se pide el segundo factor en cada entrada, con el
 * código de seis dígitos de la aplicación autenticadora.
 *
 * La pantalla de acceso es el componente `components/ui/auth-form-1`, que se
 * escribió para este proyecto: sin alta de cuentas (el acceso es
 * restringido a personal autorizado), sin «continuar con Google» (el DRS §10
 * exige que todo intento pase por el Middleware) y sin recuperación de
 * contraseña por correo.
 */
export default function Entrar() {
  const {
    sesion,
    operador,
    mfaPendiente,
    mfaRequerido,
    factorMfa,
    cargando,
    entrar,
    verificarMfa,
    error: errorAuth,
  } = useAuth()
  const navegar = useNavigate()

  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (sesion && operador && !mfaPendiente && !mfaRequerido) {
      navegar('/admin/turnos', { replace: true })
    }
  }, [sesion, operador, mfaPendiente, mfaRequerido, navegar])

  if (cargando) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-navy-900">
        <p className="text-sm text-gris-200">Cargando…</p>
      </div>
    )
  }

  /*
   * El segundo factor (RF-026). Hay dos casos y son pantallas distintas:
   *
   *   · mfaRequerido: el factor ya está inscrito y verificado, pero la
   *     sesión es de un solo factor. Falta el CÓDIGO. Es lo que pasa en
   *     cada acceso.
   *   · mfaPendiente: la cuenta todavía no tiene MFA. Falta INSCRIBIRLO.
   */
  if (sesion && operador && mfaRequerido && factorMfa) {
    return <VerificacionMFA factorId={factorMfa} />
  }

  // El factor ya está inscrito pero la cuenta aún no puede operar: hay que
  // inscribirlo. La pantalla siguiente lo pide.
  if (sesion && operador && mfaPendiente) {
    return <InscripcionMFA />
  }

  return (
    // `main` como landmark: sin él, el contenido del login no está dentro de
    // ninguna región (WCAG 1.3.1) y un lector de pantalla no puede saltar
    // al contenido.
    <main className="flex min-h-screen items-center justify-center bg-navy-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src="/logo-durango.png"
            alt="Emblema del Municipio de Durango"
            className="h-20 w-auto"
          />
          <p className="mt-3 text-sm text-gris-200">
            Sistema de Gestión y Seguimiento de Turnos
          </p>
          <p className="text-xs text-gris-200">Dirección de Catastro · Durango</p>
        </div>

        <Acceso
          errorExterno={error ?? errorAuth}
          onIniciar={async (correo, clave) => {
            setError(null)
            const resultado = await entrar(correo, clave)
            return resultado
          }}
          onVerificar={verificarMfa}
        />
      </div>
    </main>
  )
}

/**
 * Verificación del segundo factor (RF-026).
 *
 * Es el caso de cada acceso: la contraseña ya se comprobó y la sesión está
 * abierta con un solo factor. Falta el código de seis dígitos de la
 * aplicación autenticadora.
 */
function VerificacionMFA({ factorId }: { factorId: string }) {
  const { salir, verificarMfa } = useAuth()
  const [estado, setEstado] = useState<OtpStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [verificando, setVerificando] = useState(false)

  async function confirmar(codigo: string) {
    setVerificando(true)
    setError(null)
    try {
      await verificarMfa(factorId, codigo)
      setEstado('success')
    } catch (e) {
      setEstado('error')
      setError(e instanceof Error ? e.message : 'El código no es correcto.')
    } finally {
      setVerificando(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-navy-900 p-4">
      <div className="tarjeta w-full max-w-md p-6 text-center">
        <h1 className="text-lg font-bold text-navy-800">Verificación en dos pasos</h1>
        <p className="mt-1 text-sm text-gris-700">
          Escriba el código de seis dígitos que muestra su aplicación autenticadora. Sin
          él, la consola no se abre (RF-026).
        </p>

        {error && (
          <div className="mt-4">
            <Aviso tono="peligro">{error}</Aviso>
          </div>
        )}

        <div className="mt-6 flex justify-center">
          <OtpInput
            length={6}
            mode="numeric"
            autoFocus
            disabled={verificando}
            status={estado}
            onComplete={confirmar}
            errorMessage={error ?? 'El código no es correcto.'}
            successMessage="Código aceptado."
            hint="El que muestra su aplicación autenticadora."
            label="Código de verificación"
          />
        </div>

        {verificando && (
          <p className="mt-4 text-sm text-gris-500">Verificando…</p>
        )}

        <button
          type="button"
          onClick={salir}
          className="mt-6 w-full text-center text-xs text-gris-500 hover:text-gris-700"
        >
          Cerrar sesión
        </button>
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
  const [error, setError] = useState<string | null>(null)
  const [estado, setEstado] = useState<OtpStatus>('idle')
  const [verificando, setVerificando] = useState(false)
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

  async function confirmar(codigo: string) {
    if (!factorId) return
    setError(null)
    setVerificando(true)
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: codigo.trim(),
    })
    setVerificando(false)
    if (err) {
      setEstado('error')
      setError(err.message)
      return
    }

    /*
     * El factor ya está verificado en Auth; ahora se apunta en la ficha del
     * operador, que es lo que mira la consola para dejarle operar. Si esta
     * llamada falla, se dice: el MFA existe pero el permiso no, y quedarse en
     * «MFA configurado» sería mentir.
     */
    try {
      await marcarMfaHabilitado()
    } catch (e) {
      setEstado('error')
      setError(
        e instanceof Error
          ? e.message
          : 'El segundo factor quedó inscrito, pero no se pudo habilitar la cuenta.',
      )
      return
    }

    setEstado('success')
    setListo(true)
    await recargar()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-900 p-4">
      <div className="w-full max-w-md">
        <div className="tarjeta p-6">
          <h1 className="text-lg font-bold text-navy-800">
            Active la verificación en dos pasos
          </h1>
          <p className="mt-1 text-sm text-gris-700">
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
                <div className="space-y-4">
                  <div className="rounded-lg border border-gris-100 bg-gris-50 p-4 text-center">
                    {qr && (
                      <img
                        src={qr}
                        alt="Código QR para la aplicación autenticadora"
                        className="mx-auto h-48 w-48"
                      />
                    )}
                  </div>
                  {secreto && (
                    <p className="break-all rounded-lg bg-gris-50 px-3 py-2 font-mono text-xs text-azul-600">
                      {secreto}
                    </p>
                  )}
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-navy-900">
                      Código de 6 dígitos
                    </p>
                    <div className="flex justify-center">
                      <OtpInput
                        length={6}
                        mode="numeric"
                        autoFocus
                        disabled={verificando}
                        status={estado}
                        onComplete={confirmar}
                        errorMessage={error ?? 'El código no es correcto.'}
                        successMessage="Código aceptado."
                        hint="El que muestra su aplicación autenticadora."
                        label="Código de verificación"
                      />
                    </div>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={salir}
                className="w-full text-center text-xs text-gris-500 hover:text-gris-700"
              >
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
