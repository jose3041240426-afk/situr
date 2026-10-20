import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

/**
 * SITUR — Emisor de notificaciones push (RF-028, DRS §6).
 *
 * Es la **única** pieza que envía Web Push. Un Vercel Cron la invoca cada
 * minuto; ella:
 *
 *   1. pregunta a la base a quién hay que avisar (`suscripciones_por_notificar`),
 *   2. firma con VAPID y entrega el aviso al navegador,
 *   3. marca la entrega (`marcar_aviso_push_enviado`) para no repetirlo.
 *
 * No es lógica de negocio de turnos: la **autoridad es PostgreSQL**, que dice
 * a quién avisar y con qué texto. Aquí solo se entrega el mensaje.
 *
 * La cola está revocada a `anon` y a `authenticated`: por eso esta función
 * usa la `service_role`, que nunca sale del servidor.
 */

export const config = {
  // El cron de Vercel llama a esta ruta por GET; también se acepta POST.
  runtime: 'nodejs',
}

interface FilaCola {
  turno_id: string
  endpoint: string
  clave_p256dh: string
  clave_auth: string
  codigo_turno: string
  folio: number
  modulo_codigo: string | null
  tipo_aviso: string
  mensaje: string
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)

  // Solo el cron de Vercel debe poder disparar el envío.
  if (!esLlamadaLegitima(req, url)) {
    return new Response('No autorizado', { status: 401 })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:catastro@durango.gob.mx'

  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate) {
    return new Response(
      JSON.stringify({ error: 'Faltan variables de entorno del emisor de push.' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1) La base decide a quién toca avisar.
  const { data, error } = await supabase.rpc('suscripciones_por_notificar')
  if (error) {
    console.error('[situr/push] la cola falló:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  const cola = (data ?? []) as FilaCola[]
  if (cola.length === 0) {
    return new Response(JSON.stringify({ enviados: 0, motivo: 'cola vacía' }), { status: 200 })
  }

  let enviados = 0
  let fallidos = 0
  let borrados = 0

  for (const fila of cola) {
    try {
      await webpush.sendNotification(
        {
          endpoint: fila.endpoint,
          keys: { p256dh: fila.clave_p256dh, auth: fila.clave_auth },
        },
        JSON.stringify({
          title: 'SITUR · Su turno',
          body: fila.mensaje,
          codigo: fila.codigo_turno,
          folio: fila.folio,
          modulo: fila.modulo_codigo,
          // **Sin URL y sin token.** El destino lo resuelve el Service
          // Worker del propio ciudadano con el token que tiene guardado
          // en local: mandarlo en el aviso lo mandaría al proveedor de
          // push, que es un tercero (DRS §5.2, «contenido mínimo del
          // aviso»). Antes además mandaba el id del turno en una ruta
          // que espera el token, así que el aviso abría una página de
          // error.
        }),
      )

      // 3) La marca impide que el cron vuelva a ofrecer el mismo aviso.
      const { error: errMarca } = await supabase.rpc('marcar_aviso_push_enviado', {
        p_turno_id: fila.turno_id,
      })
      if (errMarca) {
        console.error('[situr/push] no se pudo marcar la entrega:', errMarca.message)
      }
      enviados++
    } catch (e: unknown) {
      const estado = (e as { statusCode?: number })?.statusCode
      if (estado === 404 || estado === 410) {
        // El navegador eliminó la suscripción: se retira de la base. Se
        // llama por `turno_id` para que el token no viaje en esta ruta.
        const { error: errBorrado } = await supabase.rpc('eliminar_suscripcion_por_turno', {
          p_turno_id: fila.turno_id,
        })
        if (errBorrado) {
          console.error('[situr/push] no se pudo retirar la suscripción:', errBorrado.message)
        }
        borrados++
      } else {
        fallidos++
        console.error('[situr/push] fallo al enviar:', (e as Error)?.message)
      }
    }
  }

  return new Response(
    JSON.stringify({ encolados: cola.length, enviados, fallidos, borrados }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * Autoriza la llamada al emisor.
 *
 * 1) Con `CRON_SECRET` configurado — **la vía de producción** —: el cron de
 *    Vercel manda `Authorization: Bearer <secreto>` y solo se acepta eso.
 *    Sin este secreto, la función sería un generador de avisos abierto a
 *    internet (DRS §10).
 *
 * 2) Sin secreto y en producción: no se acepta nada. Queda Inaccesible hasta
 *    que se configure `CRON_SECRET`, que es lo correcto: es preferible no
 *    enviar avisos a dejarlos abiertos.
 *
 * 3) En desarrollo: se permite, porque allí el cron no existe y hay que poder
 *    probar el envío a mano.
 */
function esLlamadaLegitima(req: Request, url: URL): boolean {
  const secreto = process.env.CRON_SECRET
  if (secreto) {
    return req.headers.get('authorization') === `Bearer ${secreto}`
  }
  if (process.env.NODE_ENV === 'production') {
    // ANTES se comparaba la cabecera `Host` con VERCEL_URL, y eso no es una
    // comprobacion: la cabecera `Host` la elige el cliente, de modo que
    // cualquiera podia mandarla con el valor correcto y disparar el emisor de
    // avisos. Fallar cerrado: mejor no enviar avisos que dejarlos abiertos.
    console.error(
      '[situr/push] CRON_SECRET no esta configurado: se rechaza el envio. ' +
        'Genere uno y paselo a Vercel como variable de entorno.',
    )
    return false
  }
  void url
  return true
}
