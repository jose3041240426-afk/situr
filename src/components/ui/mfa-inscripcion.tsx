import { useState } from 'react'
import { OtpInput, type OtpStatus } from './otp-input'
import { Aviso } from '../ui'
import { inscribirFactor, listarFactores, quitarFactor, verificarFactor } from '../../lib/mfa'
import { marcarMfaHabilitado } from '../../lib/rpc'

/**
 * SITUR — Inscripción del segundo factor (RF-026).
 *
 * El proceso en tres pasos: se genera el factor, la persona escanea el QR con
 * su aplicación autenticadora y escribe el código de seis dígitos que le
 * sale. Al acertar, el factor queda verificado en Supabase Auth y la ficha
 * del operador se marca con `mfa_habilitado`.
 *
 * ESTE COMPONENTE SE USA EN DOS SITIOS
 *
 *   1. En la pantalla de acceso, cuando la cuenta todavía no tiene factor:
 *      es el primer acceso y no hay más remedio (RF-026).
 *   2. En la ficha de perfil, para activarlo o para cambiarlo.
 *
 * Por eso la parte visual va aparte de la parte de la lógica: el marco (la
 * pantalla del login o el diálogo del perfil) lo pone quien lo usa.
 */
export interface PropsMfaInscripcion {
  /** Se llama cuando el factor queda verificado y la cuenta habilitada. */
  onListo: () => void
  /** Texto del botón que empieza la inscripción. */
  textoBoton: string
  /** Se llama cuando el usuario cancela. */
  onCancelar?: () => void
  /** Texto del botón de cancelar. Si no se da, no hay botón. */
  textoCancelar?: string
}

export function MfaInscripcion({
  onListo,
  textoBoton,
  onCancelar,
  textoCancelar,
}: PropsMfaInscripcion) {
  const [qr, setQr] = useState<string | null>(null)
  const [secreto, setSecreto] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [estado, setEstado] = useState<OtpStatus>('idle')
  const [verificando, setVerificando] = useState(false)
  const [listo, setListo] = useState(false)

  async function enrollar() {
    setError(null)
    try {
      /*
       * GoTrue solo admite UN factor sin verificar a la vez. Si quedó uno
       * pendiente de una inscripción anterior —alguien cerró el diálogo a
       * medias—, la inscripción nueva falla con «maximum number of factors».
       *
       * Se quitan antes los que no estén verificados. Los verificados NO se
       * tocan aquí: quitarlos es otra operación, la que hace `GestionMfa`
       * cuando lo que se quiere es cambiar el factor.
       */
      const factores = await listarFactores()
      for (const f of factores) {
        if (!f.verificado) await quitarFactor(f.id)
      }

      const alta = await inscribirFactor()
      setQr(alta.qr)
      setSecreto(alta.secreto)
      setFactorId(alta.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar la inscripción.')
    }
  }

  async function confirmar(codigo: string) {
    if (!factorId) return
    setError(null)
    setVerificando(true)
    try {
      await verificarFactor(factorId, codigo)
    } catch (e) {
      setVerificando(false)
      setEstado('error')
      setError(e instanceof Error ? e.message : 'El código no es correcto.')
      return
    }
    setVerificando(false)

    /*
     * El factor ya está verificado en Auth; ahora se apunta en la ficha del
     * operador, que es lo que mira la consola para dejarle operar. Si esta
     * llamada falla, se dice: el MFA existe pero el permiso no, y quedarse
     * en «MFA configurado» sería mentir.
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
    onListo()
  }

  if (listo) {
    return (
      <div className="space-y-4">
        <Aviso tono="ok">
          El segundo factor quedó verificado. A partir de ahora, cada entrada
          pide el código.
        </Aviso>
        {onCancelar && (
          <button type="button" onClick={onCancelar} className="boton-primario w-full">
            {textoCancelar ?? 'Continuar'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && <Aviso tono="peligro">{error}</Aviso>}

      {!qr ? (
        <button type="button" onClick={enrollar} className="boton-primario w-full">
          {textoBoton}
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

          {/*
            El secreto, por si el QR no se puede escanear (la cámara del
            equipo de la ventanilla, un teléfono sin cámara, un papel
            impreso). Es la misma clave que va en el QR: con ella se puede
            configurar la aplicación a mano.
          */}
          {secreto && (
            <div>
              <p className="mb-1 text-xs text-gris-500">
                Si no puede escanear el QR, escriba esta clave en la aplicación:
              </p>
              <p className="break-all rounded-lg bg-gris-50 px-3 py-2 font-mono text-xs text-azul-600">
                {secreto}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-navy-900">Código de 6 dígitos</p>
            {/*
              `pb-7` reserva el sitio del mensaje.

              El texto de estado del campo de código («El código no es
              correcto…», «Código aceptado.») va en posición absoluta debajo
              de las celdas, para no estirar el grupo ni descentrarlo. Como no
              ocupa espacio, dentro de un diálogo se salía por debajo y
              quedaba cortado. Con este margen, el mensaje entra en el
              diálogo y se lee entero.
            */}
            <div className="flex justify-center pb-7">
              <OtpInput
                length={6}
                mode="numeric"
                autoFocus
                disabled={verificando}
                status={estado}
                onComplete={confirmar}
                errorMessage={error ?? 'El código no es correcto.'}
                successMessage="Código aceptado."
                label="Código de verificación"
              />
            </div>
          </div>

          {verificando && <p className="text-center text-sm text-gris-500">Verificando…</p>}
        </div>
      )}
    </div>
  )
}

export default MfaInscripcion
