import { createClient } from '@supabase/supabase-js'

/**
 * SITUR — Alta y baja de suscripciones push (RF-028, DRS §10).
 *
 * Por qué existe esta ruta y no se llama a Supabase directo desde el
 * navegador: el DRS pide limitar por **IP + token** el alta de suscripciones.
 * Si el navegador llamara a Supabase directamente, esa petición no pasaría
 * por el Edge Middleware y el límite no existiría. Pasando por aquí, sí.
 *
 * Quién autoriza la operación es **el token**, no la sesión: el ciudadano es
 * anónimo (RF-017) y la RPC valida el token por su cuenta. Por eso la clave
 * que se usa aquí es la `anon`, no la `service_role`.
 */

export const config = { runtime: 'nodejs' }

interface CuerpoAlta {
  token: string
  endpoint: string
  clave_p256dh: string
  clave_auth: string
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !anonKey) {
    return new Response(
      JSON.stringify({ error: 'Faltan las variables de entorno de Supabase.' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ---------------------------------------------------------------- baja
  if (req.method === 'DELETE') {
    const token = url.searchParams.get('token') ?? ''
    if (!token) {
      return new Response(JSON.stringify({ error: 'Falta el token.' }), { status: 400 })
    }
    const { data, error } = await supabase.rpc('eliminar_suscripcion_push', {
      p_token: token,
    })
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 })
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  // ---------------------------------------------------------------- alta
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), { status: 405 })
  }

  let cuerpo: CuerpoAlta
  try {
    cuerpo = (await req.json()) as CuerpoAlta
  } catch {
    return new Response(JSON.stringify({ error: 'Cuerpo inválido.' }), { status: 400 })
  }

  const { token, endpoint, clave_p256dh, clave_auth } = cuerpo
  if (!token || !endpoint || !clave_p256dh || !clave_auth) {
    return new Response(
      JSON.stringify({ error: 'Faltan datos de la suscripción.' }),
      { status: 400 },
    )
  }

  const { data, error } = await supabase.rpc('registrar_suscripcion_push', {
    p_token: token,
    p_endpoint: endpoint,
    p_clave_p256dh: clave_p256dh,
    p_clave_auth: clave_auth,
  })
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 })
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
