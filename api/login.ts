/**
 * SITUR — Acceso del operador (RF-001, DRS §10).
 *
 * El mismo motivo que en `api/turno.ts`: si el navegador llama directamente
 * a `supabase.auth.signInWithPassword`, la petición de contraseña **nunca pasa
 * por el Edge Middleware**, y el límite por IP y por cuenta que el DRS §10
 * pide para el login no existe: no se puede contar un intento que no pasa por
 * aquí. Con esta ruta, el intento sí se ve y se puede frenar.
 *
 * Aquí no se inventa nada: se reenvía el intento a la API de autenticación
 * de Supabase y se devuelve su respuesta tal cual. La clave que se usa es la
 * **anon** —la de la aplicación, que es pública por definición— y la
 * contraseña del operador **no se guarda aquí**: viaja de paso a Supabase.
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

  let cuerpo: { email?: string; password?: string }
  try {
    cuerpo = (await req.json()) as { email?: string; password?: string }
  } catch {
    return new Response(JSON.stringify({ error: 'Cuerpo inválido.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const email = String(cuerpo.email ?? '').trim().toLowerCase()
  const password = String(cuerpo.password ?? '')

  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Faltan el correo o la contraseña.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const respuesta = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  const texto = await respuesta.text()

  // La respuesta de Supabase se devuelve tal cual: el cliente necesita el
  // `access_token` y el `refresh_token` para abrir la sesión. El error de
  // credenciales tampoco se reescribe: aquí no se guarda nada ni se registra
  // el intento con la contraseña.
  return new Response(texto, {
    status: respuesta.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}
