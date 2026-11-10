import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

/**
 * SITUR — Prueba del aviso (diagnóstico).
 *
 * Existe para responder la pregunta que no se puede responder mirando el
 * código: «¿el aviso llega de verdad al teléfono?».
 *
 * No es el emisor de producción: ese es `/api/push` y lo dispara el cron. Aquí
 * se manda un aviso de prueba **a un solo turno**, identificado por su token,
 * y se devuelve el resultado para que el ciudadano vea en pantalla qué pasó.
 *
 * Autorización: el token del turno. Es el mismo secreto que abre el portal, y
 * solo sirve para este turno. No necesita `CRON_SECRET`.
 */

export const config = { runtime: 'nodejs' }

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url, `https://${req.headers.get('host') ?? 'localhost'}`)
  const token = url.searchParams.get('token')

  if (!token || token.length < 32) {
    return new Response(JSON.stringify({ ok: false, motivo: 'Token inválido.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:catastro@durango.gob.mx'

  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate) {
    return new Response(
      JSON.stringify({ ok: false, motivo: 'Faltan variables de entorno del emisor.' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1) La suscripción de este turno.
  const { data: subs, error: errSub } = await supabase
    .from('suscripciones_push')
    .select('endpoint, clave_p256dh, clave_auth, activa')
    .eq('token_publico', token)
    .maybeSingle()

  if (errSub) {
    return new Response(JSON.stringify({ ok: false, motivo: errSub.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (!subs) {
    return new Response(
      JSON.stringify({
        ok: false,
        motivo: 'No hay suscripción para este turno. Acepte el aviso primero.',
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }
  if (!subs.activa) {
    return new Response(
      JSON.stringify({ ok: false, motivo: 'La suscripción está desactivada.' }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    )
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

  try {
    await webpush.sendNotification(
      {
        endpoint: subs.endpoint,
        keys: { p256dh: subs.clave_p256dh, auth: subs.clave_auth },
      },
      JSON.stringify({
        title: 'SITUR · Aviso de prueba',
        body: 'Si lee esto, el aviso push funciona en este dispositivo.',
        codigo: 'PRUEBA',
        folio: 0,
        modulo: 'M01',
      }),
    )
    return new Response(JSON.stringify({ ok: true, motivo: 'Enviado. Debe sonar en el móvil.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (e: unknown) {
    const estado = (e as { statusCode?: number })?.statusCode
    return new Response(
      JSON.stringify({
        ok: false,
        motivo: `Fallo al enviar (HTTP ${estado ?? '?'}): ${(e as Error)?.message ?? 'desconocido'}`,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }
}

export const GET = handler
export const POST = handler
