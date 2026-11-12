import { supabase } from './supabase'

/**
 * SITUR — El segundo factor (MFA).
 *
 * Todo lo que hay que hacer con los factores de autenticación de Supabase
 * vive aquí: listarlos, inscribir uno, comprobar un código y quitarlo.
 *
 * Las llamadas van contra la API de Auth del navegador con la sesión del
 * operador: el `anon` key no puede tocar los factores de nadie, así que hace
 * falta la sesión.
 */

/** Un factor registrado en la cuenta. */
export interface FactorMfa {
  id: string
  verificado: boolean
}

/**
 * Todos los factores de la cuenta, verificados o no.
 *
 * GoTrue no expone la lista por el método HTTP habitual (`GET /factors` da
 * 405), pero la biblioteca de Supabase sí la pide por su cuenta.
 *
 * Sirve para dos cosas: saber si hay un factor verificado (el que cuenta
 * para entrar) y saber si hay un factor **pendiente** de verificar, que se
 * queda ahí si alguien cierra el diálogo a medias y ocupa el sitio del
 * siguiente.
 */
export async function listarFactores(): Promise<FactorMfa[]> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw new Error(error.message)
  return (data?.totp ?? []).map((f) => ({
    id: f.id,
    verificado: f.status === 'verified',
  }))
}

/** El factor VERIFICADO de la cuenta, si hay alguno. */
export async function factorVerificado(): Promise<FactorMfa | null> {
  const factores = await listarFactores()
  return factores.find((f) => f.verificado) ?? null
}

/** Lo que devuelve una inscripción: el QR para escanear y el secreto a mano. */
export interface Inscripcion {
  id: string
  qr: string
  secreto: string
}

/**
 * Inscribe un factor nuevo.
 *
 * GoTrue solo deja un factor sin verificar a la vez: si ya hay uno pendiente,
 * hay que quitarlo antes (por eso `cambiar` quita el viejo primero).
 */
export async function inscribirFactor(): Promise<Inscripcion> {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'SITUR',
  })
  if (error || !data) {
    throw new Error(error?.message ?? 'No se pudo iniciar la inscripción.')
  }
  return { id: data.id, qr: data.totp.qr_code, secreto: data.totp.secret }
}

/**
 * Comprueba un código contra un factor.
 *
 * `challengeAndVerify` hace el reto por su cuenta cuando se le pasa el
 * identificador del factor, así que no hay que pedir el reto aparte.
 */
export async function verificarFactor(factorId: string, codigo: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: codigo.trim(),
  })
  if (error) throw new Error(error.message)
}

/**
 * Quita un factor de la cuenta.
 *
 * Para quitar un factor ya verificado hace falta que la sesión sea de dos
 * factores: GoTrue lo pide así, y es lo correcto — quien puede quitar el
 * segundo factor es quien tiene el segundo factor.
 */
export async function quitarFactor(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  if (error) throw new Error(error.message)
}
