'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AnimatePresence, motion } from 'motion/react'
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OtpInput, type OtpStatus } from '@/components/ui/otp-input'
import { cn } from '@/lib/utils'

/**
 * SITUR — Acceso del operador.
 *
 * ESTE COMPONENTE ESTÁ ADAPTADO al proyecto, no es el de shadcn tal cual.
 * Las diferencias son deliberadas:
 *
 *   · NO hay «Crear cuenta». El acceso es restringido a personal dado de
 *     alta (RF-001): el alta la hace un administrador, no el propio
 *     operador. Un formulario de registro público abriría la puerta.
 *
 *   · NO hay «Continuar con Google». El DRS §10 exige que TODO intento de
 *     acceso pase por el Edge Middleware, que es lo que cuenta los
 *     intentos por IP y por cuenta. Un proveedor externo se saltaría ese
 *     control y además mandaría el correo del operador a un tercero.
 *
 *   · NO hay «Olvidé mi contraseña». La recuperación la hace la Dirección de
 *     Catastro, no un correo automático: el sistema es clasificado y no
 *     envía credenciales por correo.
 *
 *   · SÍ hay verificación en dos pasos (MFA, RF-026) en CADA acceso, con el
 *     campo de código de seis dígitos. La inscripción del factor la pide
 *     la pantalla siguiente, la primera vez.
 *
 * Los textos van en español, que es el idioma del sistema.
 */

// --------------------------------
// Estados
// --------------------------------

enum VistaAcceso {
  INICIAR = 'iniciar',
  VERIFICAR = 'verificar',
}

interface EstadoAcceso {
  vista: VistaAcceso
  /** Factor de MFA contra el que se verifica el código. */
  factorId: string | null
}

interface EstadoFormulario {
  cargando: boolean
  error: string | null
  mostrarClave: boolean
}

// --------------------------------
// Esquemas
// --------------------------------

const inicioSchema = z.object({
  correo: z.string().min(1, 'Escriba su correo institucional.').email('El correo no tiene un formato válido.'),
  clave: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.'),
})

type ValoresInicio = z.infer<typeof inicioSchema>

// --------------------------------
// Componente principal
// --------------------------------

export interface PropsAcceso {
  /** Credenciales del operador. */
  onIniciar: (correo: string, clave: string) => Promise<{ requiereMfa: boolean; factorId: string | null }>
  /** Verificación del código de seis dígitos del segundo factor. */
  onVerificar: (factorId: string, codigo: string) => Promise<void>
  /** Se llama cuando el acceso necesita el segundo factor. */
  onMfaRequerido?: (factorId: string) => void
  /** Error que viene del contexto de autenticación. */
  errorExterno?: string | null
  className?: string
}

function Acceso({
  onIniciar,
  onVerificar,
  onMfaRequerido,
  errorExterno,
  className,
}: PropsAcceso) {
  const [estado, setEstado] = React.useState<EstadoAcceso>({
    vista: VistaAcceso.INICIAR,
    factorId: null,
  })

  const setVista = React.useCallback((vista: VistaAcceso, factorId: string | null = null) => {
    setEstado({ vista, factorId })
  }, [])

  return (
    <div data-slot="auth" className={cn('mx-auto w-full max-w-md', className)}>
      <div className="relative overflow-hidden rounded-xl border border-gris-200 bg-white shadow-xl">
        <div className="absolute inset-0 bg-gradient-to-br from-azul-500/5 to-navy-900/5" />
        <div className="relative z-10">
          <AnimatePresence mode="wait">
            {estado.vista === VistaAcceso.INICIAR && (
              <AccesoIniciar
                key="iniciar"
                errorExterno={errorExterno}
                onContinuar={async (correo, clave) => {
                  const { requiereMfa, factorId } = await onIniciar(correo, clave)
                  if (requiereMfa && factorId) {
                    onMfaRequerido?.(factorId)
                    setVista(VistaAcceso.VERIFICAR, factorId)
                  }
                }}
              />
            )}
            {estado.vista === VistaAcceso.VERIFICAR && estado.factorId && (
              <AccesoVerificar
                key="verificar"
                factorId={estado.factorId}
                onVerificar={onVerificar}
                onVolver={() => setVista(VistaAcceso.INICIAR)}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

// --------------------------------
// Piezas comunes
// --------------------------------

interface PropsError {
  mensaje: string | null
}

function ErrorAcceso({ mensaje }: PropsError) {
  if (!mensaje) return null
  return (
    <div
      data-slot="auth-error"
      role="alert"
      className="mb-6 rounded-lg border border-rojo-500/20 bg-rojo-50 p-4 text-sm text-rojo-600"
    >
      {mensaje}
    </div>
  )
}

// --------------------------------
// Vista de inicio de sesión
// --------------------------------

interface PropsInicio {
  onContinuar: (correo: string, clave: string) => Promise<void>
  errorExterno?: string | null
}

function AccesoIniciar({ onContinuar, errorExterno }: PropsInicio) {
  const [formState, setFormState] = React.useState<EstadoFormulario>({
    cargando: false,
    error: null,
    mostrarClave: false,
  })

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ValoresInicio>({
    resolver: zodResolver(inicioSchema),
    defaultValues: { correo: '', clave: '' },
  })

  const onSubmit = async (data: ValoresInicio) => {
    setFormState((prev) => ({ ...prev, cargando: true, error: null }))
    try {
      await onContinuar(data.correo.trim(), data.clave)
    } catch (e) {
      setFormState((prev) => ({
        ...prev,
        error: e instanceof Error ? e.message : 'No se pudo iniciar sesión.',
      }))
    } finally {
      setFormState((prev) => ({ ...prev, cargando: false }))
    }
  }

  return (
    <motion.div
      data-slot="auth-sign-in"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="p-8"
    >
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-black text-navy-900">Iniciar sesión</h1>
        <p className="mt-1 text-sm text-gris-500">
          Acceso restringido a personal autorizado
        </p>
      </div>

      <ErrorAcceso mensaje={formState.error ?? errorExterno ?? null} />

      <form onSubmit={handleSubmit(onSubmit)} data-slot="auth-form" className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="correo">Correo institucional</Label>
          <Input
            id="correo"
            type="email"
            autoComplete="username"
            placeholder="nombre@catastro.durango.gob.mx"
            disabled={formState.cargando}
            className={cn(errors.correo && 'border-rojo-500')}
            {...register('correo')}
          />
          {errors.correo && <p className="text-xs text-rojo-600">{errors.correo.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="clave">Contraseña</Label>
          <div className="relative">
            <Input
              id="clave"
              type={formState.mostrarClave ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              disabled={formState.cargando}
              className={cn('pr-11', errors.clave && 'border-rojo-500')}
              {...register('clave')}
            />
            <button
              type="button"
              onClick={() =>
                setFormState((prev) => ({ ...prev, mostrarClave: !prev.mostrarClave }))
              }
              disabled={formState.cargando}
              className="absolute right-1 top-0 flex h-full w-10 items-center justify-center rounded-md text-gris-500 transition-colors hover:text-navy-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              aria-label={formState.mostrarClave ? 'Ocultar la contraseña' : 'Mostrar la contraseña'}
            >
              {formState.mostrarClave ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {errors.clave && <p className="text-xs text-rojo-600">{errors.clave.message}</p>}
        </div>

        <Button type="submit" className="w-full" disabled={formState.cargando}>
          {formState.cargando ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Entrando…
            </>
          ) : (
            'Entrar'
          )}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-gris-500">
        Acceso restringido a personal autorizado (RF-001). Si no puede entrar, avise a la
        Dirección de Catastro.
      </p>
    </motion.div>
  )
}

// --------------------------------
// Vista de verificación en dos pasos
// --------------------------------

interface PropsVerificar {
  factorId: string
  onVerificar: (factorId: string, codigo: string) => Promise<void>
  onVolver: () => void
}

function AccesoVerificar({ factorId, onVerificar, onVolver }: PropsVerificar) {
  const [estado, setEstado] = React.useState<OtpStatus>('idle')
  const [cargando, setCargando] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const onCompletar = async (codigo: string) => {
    setCargando(true)
    setError(null)
    try {
      await onVerificar(factorId, codigo)
      setEstado('success')
    } catch (e) {
      setEstado('error')
      setError(e instanceof Error ? e.message : 'El código no es correcto.')
    } finally {
      setCargando(false)
    }
  }

  return (
    <motion.div
      data-slot="auth-mfa"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="flex flex-col items-center p-8 text-center"
    >
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-azul-500/10">
        <ShieldCheck className="h-7 w-7 text-azul-500" />
      </div>

      <h1 className="text-xl font-bold text-navy-900">Verificación en dos pasos</h1>
      <p className="mt-1 max-w-xs text-sm text-gris-500">
        Escriba el código de seis dígitos que muestra su aplicación autenticadora.
      </p>

      <div className="mt-6">
        <OtpInput
          length={6}
          mode="numeric"
          autoFocus
          disabled={cargando}
          status={estado}
          onComplete={onCompletar}
          errorMessage={error ?? 'El código no es correcto.'}
          successMessage="Código accepted."
          hint="Six digits, from your authenticator app."
          label="Código de verificación"
        />
      </div>

      {cargando && (
        <p className="mt-4 flex items-center gap-2 text-sm text-gris-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verificando…
        </p>
      )}

      <Button
        type="button"
        variant="ghost"
        onClick={onVolver}
        disabled={cargando}
        className="mt-6 text-gris-500"
      >
        Volver al inicio de sesión
      </Button>
    </motion.div>
  )
}

// --------------------------------
// Exportaciones
// --------------------------------

export { Acceso, AccesoIniciar, AccesoVerificar, ErrorAcceso }
export default Acceso
