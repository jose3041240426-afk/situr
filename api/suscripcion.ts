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

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url, `https://${req.headers.get('host') ?? 'localhost'}`)
  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

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

  /*
   * Si el turno ya estaba llamado cuando el ciudadano se suscribió, el cron
   * no lo va a ofrecer (ultima_activacion queda NULL y la regla de CALLED
   * exige ultima_activacion < llamado_en, que es verdad, pero el cron pasa
   * cada 5 minutos). Para no hacer esperar al ciudadano, se envía en el
   * acto: el propio servidor llama a /api/push con el secreto del cron, que
   * es lo que autoriza el envío.
   */
  if (serviceKey) {
    try {
      const admin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data: turno } = await admin
        .from('turnos')
        .select('id, estado')
        .eq('token_publico', token)
        .maybeSingle()
      if (turno?.estado === 'CALLED') {
        const secreto = process.env.CRON_SECRET
        if (secreto) {
          fetch(
            new URL(`/api/push?turno_id=${encodeURIComponent(turno.id)}`, `https://${req.headers.get('host') ?? 'localhost'}`),
            { method: 'POST', headers: { Authorization: `Bearer ${secreto}` } },
          ).catch(() => undefined)
        }
      }
    } catch (e) {
      // No interrumpe el alta: la suscripción ya está guardada y el cron
      // la recogerá en su siguiente vuelta.
      console.error('[situr/suscripcion] aviso inmediato no pudo enviarse:', e instanceof Error ? e.message : e)
    }
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/*
 * Vercel (runtime de Node) no usa el valor que devuelve un `export
 * default`: hay que declarar cada método HTTP como export con nombre.
 * En desarrollo lo monta el plugin de Vite, que sí acepta el handler
 * suelto; el cuerpo y el comportamiento son los mismos.
 */
export const POST = handler
export const DELETE = handler
