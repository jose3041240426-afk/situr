import { createClient } from '@supabase/supabase-js'

/**
 * SITUR — Consulta pública del turno (RF-017, RF-018, DRS §10).
 *
 * ¿POR QUÉ EXISTE ESTE ENDPOINT, Y NO LLAMAR A SUPABASE DESDE EL NAVEGADOR?
 *
 * El DRS §10 pide limitar por IP + token la consulta pública. Si el navegador
 * llama a `get_turno_publico` directamente a Supabase, esa petición **nunca
 * pasa por el Edge Middleware**, y el límite no existe: el que se ponía sobre
 * la página `/turno/{token}` solo limitaba la descarga del HTML.
 *
 * Con esta ruta, la consulta pasa por el servidor y sí se puede limitar. El
 * token sigue siendo la credencial (RF-017: sin cuenta, sin correo, sin
 * teléfono) y la RLS sigue aplicando: aquí se usa la clave **anon**, que no
 * ve nada que la política no le deje.
 */
export const config = { runtime: 'nodejs' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(req.url)
  const token = url.searchParams.get('token') ?? ''

  if (!token || token.length < 32) {
    return new Response(JSON.stringify({ error: 'Token invalido.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Configuracion incompleta.' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Clave **anon**: esta función no necesita más. Con la `service_role` la
  // RLS dejaría de aplicar y la función vería todo lo que hay en la base.
  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.rpc('get_turno_publico', { p_token: token })

  if (error) {
    // El mensaje de la RPC es de negocio ("Token expirado", "Token invalido"),
    // no una traza: se puede devolver al ciudadano.
    const codigo = error.code === 'P0001' ? 410 : error.code === 'P0002' ? 404 : 400
    return new Response(
      JSON.stringify({ error: error.message, codigo: error.code ?? null }),
      { status: codigo, headers: { 'content-type': 'application/json' } },
    )
  }

  // Lo que la RPC devuelve ya es lo mínimo: folio, estado, posición, módulo
  // y mensaje. El token **no** sale de la base en esta ruta.
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}
