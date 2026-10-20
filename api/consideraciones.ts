import { createClient } from '@supabase/supabase-js'

/**
 * SITUR — Consideraciones del titular (RF-033, LFPDPPP art. 21).
 *
 * Toda persona titular puede oponerse al tratamiento de sus datos por causa
 * legítima. En SITUR el ciudadano no deja datos de identidad: su única
 * credencial es el token. Por eso el derecho se hace valer por ahí, con el
 * mismo token que ya lleva en el QR.
 *
 * Lo que se guarda es **lo que el titular escribe** (300 caracteres como
 * máximo) sobre un turno que no tiene nombre, correo ni teléfono. No se
 * recoge ningún dato de identidad: escribir la consideración es el ejercicio
 * del derecho, no un recollection de datos.
 *
 * Se usa la clave **anon**, no la `service_role`: la RLS sigue aplicando y
 * lo que autoriza es conocer el token.
 */
export const config = { runtime: 'nodejs' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Configuración incompleta.' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  let cuerpo: { token?: string; consideraciones?: string }
  try {
    cuerpo = (await req.json()) as { token?: string; consideraciones?: string }
  } catch {
    return new Response(JSON.stringify({ error: 'Cuerpo inválido.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const token = String(cuerpo.token ?? '')
  const consideraciones = String(cuerpo.consideraciones ?? '')

  if (!token || !consideraciones.trim()) {
    return new Response(
      JSON.stringify({ error: 'Faltan el token o la consideración.' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.rpc('manifestar_consideraciones', {
    p_token: token,
    p_consideraciones: consideraciones.trim(),
  })

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message, codigo: error.code ?? null }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
