import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { listarFactores, quitarFactor } from '../lib/mfa'
import { revalidarClave } from '../lib/rpc'
import { MfaInscripcion } from '../components/ui/mfa-inscripcion'
import { Modal } from '../components/ui'

/**
 * SITUR — El segundo factor, desde la ficha de perfil (RF-026).
 *
 * Dos cosas distintas, con dos pasos distintos:
 *
 *   · **Activarlo**: la cuenta no tiene factor. Se abre el diálogo y se
 *     inscribe. No se pide la contraseña: la del acceso ya se comprobó al
 *     entrar, y lo que se está haciendo es precisamente lo que el acceso
 *     exige.
 *
 *   · **Cambiarlo**: la cuenta ya tiene factor verificado. Antes de tocarlo
 *     se pide la contraseña, porque quitar el segundo factor de una cuenta
 *     es una operación sensible: quien puede quitarla se queda con el
 *     control de la cuenta.
 *
 * POR QUÉ SE PIDE LA CONTRASEÑA Y NO EL CÓDIGO DEL FACTOR VIEJO
 *
 * El caso real de quien entra aquí es que **cambió de teléfono**: ya no
 * tiene la aplicación antigua, así que el código viejo no se lo puede dar.
 * Pedírselo dejaría fuera justo a quien más lo necesita. La contraseña sí la
 * tiene, y la Dirección de Catastro es quien la cambia si se pierde.
 *
 * Y la comprobación se hace en el servidor (`/api/verificar-clave`) para no
 * abrir una sesión de un solo factor en el navegador: si se comprobara
 * desde aquí, el operador quedaría a medias y tendría que volver a escribir
 * el código de verificación.
 */
export default function GestionMfa({ hayFactor }: { hayFactor: boolean }) {
  const { operador, recargar } = useAuth()
  const [abierto, setAbierto] = useState(false)
  /** `clave`: se pide la contraseña. `inscripcion`: se muestra el QR. */
  const [paso, setPaso] = useState<'clave' | 'inscripcion'>(hayFactor ? 'clave' : 'inscripcion')
  const [clave, setClave] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  function abrir() {
    setError(null)
    setClave('')
    setPaso(hayFactor ? 'clave' : 'inscripcion')
    setAbierto(true)
  }

  function cerrar() {
    setAbierto(false)
    setError(null)
    setClave('')
  }

  /**
   * Comprueba la contraseña y, si es correcta, deja el sitio listo para
   * inscribir el factor nuevo.
   */
  async function comprobarClave(e: React.FormEvent) {
    e.preventDefault()
    if (!operador) return
    setError(null)
    setOcupado(true)
    try {
      const correcta = await revalidarClave(operador.email, clave)
      if (!correcta) {
        setError('La contraseña no es correcta.')
        setOcupado(false)
        return
      }

      /*
       * Se quitan los factores que hubiera: el verificado (si lo había) y
       * cualquier pendiente de una inscripción a medias.
       *
       * GoTrue solo admite un factor sin verificar a la vez, así que un
       * pendiente sobrante haría fallar la inscripción siguiente. Y quitar el
       * verificado es lo que hace que esto sea un CAMBIO y no un añadido:
       * de otro modo la cuenta tendría dos factores y el viejo seguiría
       * valiendo.
       */
      const factores = await listarFactores()
      for (const f of factores) {
        await quitarFactor(f.id)
      }

      setPaso('inscripcion')
      setOcupado(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo comprobar la contraseña.')
      setOcupado(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        className={hayFactor ? 'boton-secundario' : 'boton-primario'}
      >
        {hayFactor ? 'Cambiar el código de verificación' : 'Configurar el segundo factor'}
      </button>

      {abierto && (
        <Modal
          titulo={
            paso === 'clave'
              ? 'Cambiar el segundo factor'
              : hayFactor
                ? 'Escanee el código nuevo'
                : 'Configure el segundo factor'
          }
          ancho="max-w-md"
          onCerrar={cerrar}
        >
          {paso === 'clave' ? (
            <form onSubmit={comprobarClave} className="space-y-4">
              <p className="text-sm text-gris-700">
                Escriba su contraseña para confirmar que es usted. Al hacerlo se
                quita el código de verificación anterior y se inscribe el
                nuevo.
              </p>

              {error && (
                <p role="alert" className="text-sm font-semibold text-rojo-600">
                  {error}
                </p>
              )}

              <div>
                <label
                  htmlFor="clave-revalidacion"
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gris-500"
                >
                  Contraseña
                </label>
                <input
                  id="clave-revalidacion"
                  type="password"
                  autoComplete="current-password"
                  value={clave}
                  onChange={(e) => setClave(e.target.value)}
                  disabled={ocupado}
                  className="campo w-full"
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" className="boton-secundario" onClick={cerrar}>
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="boton-primario"
                  disabled={ocupado || clave.length === 0}
                >
                  {ocupado ? 'Comprobando…' : 'Continuar'}
                </button>
              </div>
            </form>
          ) : (
            <MfaInscripcion
              textoBoton="Generar el código"
              onListo={() => {
                cerrar()
                void recargar()
              }}
              onCancelar={cerrar}
              textoCancelar="Cerrar"
            />
          )}
        </Modal>
      )}
    </>
  )
}
