import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import Acceso from '../components/ui/auth-form-1'
import { MfaInscripcion } from '../components/ui/mfa-inscripcion'
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
    verificacionResuelta,
    cargando,
    entrar,
    verificarMfa,
    error: errorAuth,
  } = useAuth()
  const navegar = useNavigate()

  const [error, setError] = useState<string | null>(null)

  /*
   * A la consola solo se pasa cuando YA se sabe que no falta el segundo
   * factor. Sin esa espera, la navegación se disparaba en el primer render
   * en que el operador ya estaba cargado, y ese render es anterior al que
   * calcula si hace falta el código: el operador entraba a la consola sin
   * escribirlo.
   */
  useEffect(() => {
    if (!verificacionResuelta) return
    if (sesion && operador && !mfaPendiente && !mfaRequerido) {
      navegar('/admin/turnos', { replace: true })
    }
  }, [sesion, operador, mfaPendiente, mfaRequerido, verificacionResuelta, navegar])

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

        {/*
          El mensaje NO se pone aquí: el campo de código ya lo muestra
          debajo de las celdas, y ponerlo también lo duplicaba.
        */}

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
          className="mt-12 w-full text-center text-xs text-gris-500 hover:text-gris-700"
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
 *
 * El proceso vive en `components/ui/mfa-inscripcion.tsx`, que se usa también
 * en la ficha de perfil: así el primer acceso y el cambio posterior son
 * exactamente el mismo camino, con los mismos mensajes.
 */
function InscripcionMFA() {
  const { operador, salir, recargar } = useAuth()

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

          <div className="mt-5">
            <MfaInscripcion
              textoBoton="Configurar ahora"
              onListo={() => void recargar()}
              onCancelar={salir}
              textoCancelar="Cerrar sesión"
            />
          </div>
        </div>
      </div>
    </div>
  )
}