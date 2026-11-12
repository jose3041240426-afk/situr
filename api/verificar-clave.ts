/**
 * SITUR — Revalidación de la contraseña.
 *
 * Comprueba la contraseña del operador **sin abrir una sesión nueva en el
 * navegador**. Devuelve solo un «sí» o un «no»; nunca un token.
 *
 * PARA QUÉ EXISTE
 *
 * Cambiar el segundo factor es una operación sensible: quien puede quitarlo
 * se queda con el control de la cuenta. El perfil pide por eso la contraseña
 * otra vez antes de dejar cambiarlo.
 *
 * La comprobación se hace AQUÍ, en el servidor, y no en el navegador con
 * `signInWithPassword`, porque en el navegador esa llamada **abriría una
 * sesión nueva de un solo factor** y dejaría al operador a medio camino:
 * tendría que volver a escribir el código de verificación y, si se equivocaba
 * al teclearlo, se quedaría fuera de la consola.
 *
 * Aquí la sesión que se abre en el servidor se tira a la basura: no se
 * devuelve, no se guarda y la del navegador no se toca. La contraseña viaja
 * de paso a Supabase y aquí no se conserva (lo mismo que en `api/login.ts`).
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

  if (!respuesta.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: 'La contraseña no es correcta.' }),
      {
        status: 401,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    )
  }

  /*
   * La respuesta de Supabase trae los tokens de la sesión que se acaba de
   * abrir en el servidor. Aquí se descartan: el navegador solo necesita
   * saber que la contraseña era correcta.
   */
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const POST = handler
