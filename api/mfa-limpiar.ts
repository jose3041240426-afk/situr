/**
 * SITUR — Limpieza de factores de verificación pendientes (RF-026).
 *
 * GoTrue solo admite un factor **sin verificar** a la vez: si alguien cierra
 * el diálogo de inscripción a medias, el factor pendiente se queda y la
 * inscripción siguiente falla con «maximum number of factors».
 *
 * El navegador no puede limpiarlo por su cuenta, porque la lista de factores
 * solo se devuelve cuando la sesión es de **dos** factores: con un factor
 * pendiente la sesión es de uno, así que el navegador no ve el factor que
 * tiene que quitar. De ahí que esta ruta exista.
 *
 * Aquí se usa la clave de servicio para listar y quitar los factores no
 * verificados del operador. El operador se identifica por su propio token de
 * sesión, que viaja en el cuerpo: así se quitan los factores de **su**
 * cuenta, no de otra. La clave de servicio no sale del servidor.
 */
export const config = { runtime: 'nodejs' }

async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Configuración incompleta.' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  let cuerpo: { token?: string }
  try {
    cuerpo = (await req.json()) as { token?: string }
  } catch {
    return new Response(JSON.stringify({ error: 'Cuerpo inválido.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const token = String(cuerpo.token ?? '').trim()
  if (!token) {
    return new Response(JSON.stringify({ error: 'Falta la sesión.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  // El operador se resuelve con su propio token, contra la API pública.
  const me = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: `Bearer ${token}` },
  })
  if (!me.ok) {
    return new Response(JSON.stringify({ error: 'Sesión no válida.' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  const { id } = (await me.json()) as { id: string }

  // Los factores se leen con la clave de servicio (la API de administración).
  const usuario = await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  })
  if (!usuario.ok) {
    return new Response(JSON.stringify({ error: 'No se pudo leer la cuenta.' }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  const datos = (await usuario.json()) as { factors?: Array<{ id: string; status: string }> }
  const pendientes = (datos.factors ?? []).filter((f) => f.status !== 'verified')

  for (const f of pendientes) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}/factors/${f.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    })
  }

  return new Response(JSON.stringify({ ok: true, quitados: pendientes.length }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const POST = handler
