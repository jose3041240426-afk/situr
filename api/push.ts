import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

/**
 * SITUR — Emisor de notificaciones push (RF-028, DRS §6).
 *
 * Es la **única** pieza que envía Web Push. Se llama de dos maneras:
 *
 *   1. **Por pg_cron**: la base de datos la invoca una vez por minuto con
 *      `pg_net` (migración 025). Es la vía principal: GitHub Actions
 *      retrasaba sus cron programados entre 5 y 8 horas, y la ventana de
 *      aviso (turno en estado CALLED) dura solo los minutos que tarda el
 *      operador en iniciar la atención.
 *   2. **Al llamar un turno**: la consola manda `?turno_id=...` con el token
 *      del operador, y se envía el aviso **en el acto**, sin esperar al cron.
 *      Es lo que hace que el ciudadano se entere en segundos.
 *
 * No es lógica de negocio de turnos: la **autoridad es PostgreSQL**, que dice
 * a quién avisar y con qué texto. Aquí solo se entrega el mensaje.
 *
 * La cola está revocada a `anon` y a `authenticated`: por eso esta función
 * usa la `service_role`, que nunca sale del servidor.
 */

export const config = {
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

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url, `https://${req.headers.get('host') ?? 'localhost'}`)
  const turnoId = url.searchParams.get('turno_id')

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.SUPABASE_ANON_KEY
  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:catastro@durango.gob.mx'

  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate) {
    return new Response(
      JSON.stringify({ error: 'Faltan variables de entorno del emisor de push.' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  // Autorización: cron de GitHub (secreto), pg_cron (token de la base)
  // u operador (JWT de Supabase).
  const secreto = process.env.CRON_SECRET
  const cabecera = req.headers.get('authorization')
  const esCron = Boolean(secreto && cabecera === `Bearer ${secreto}`)

  // La base de datos también puede invocar el emisor: es lo que hace
  // pg_cron con la extensión pg_net, una vez por minuto. El token vive en
  // Supabase Vault y su copia en la variable SITUR_PUSH_TOKEN de Vercel,
  // así que no está escrito en ningún repositorio.
  const tokenBase = process.env.SITUR_PUSH_TOKEN
  const esBase = Boolean(tokenBase && cabecera === `Bearer ${tokenBase}`)

  let esOperador = false

  if (!esCron && !esBase && turnoId && anonKey) {
    // Verifica el JWT del operador contra Supabase y su rol.
    const cliente = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user } } = await cliente.auth.getUser(token)
    if (user) {
      const { data: operador } = await createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }).from('usuarios').select('id, activo, rol_id').eq('auth_uid', user.id).maybeSingle()
      if (operador?.activo) {
        const { data: rol } = await createClient(supabaseUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        }).from('roles').select('clave').eq('id', operador.rol_id).maybeSingle()
        if (rol?.clave === 'ADMINISTRADOR' || rol?.clave === 'AGENTE') {
          esOperador = true
        }
      }
    }
  }

  if (!esCron && !esBase && !esOperador) {
    if (!secreto && !tokenBase && process.env.NODE_ENV !== 'production') {
      // Desarrollo local: se permite probar.
    } else {
      return new Response('No autorizado', { status: 401 })
    }
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

  // La cola: por turno (inmediato) o la cola completa (cron).
  let cola: FilaCola[] = []

  if (turnoId) {
    /*
     * Aviso inmediato de un turno concreto.
     *
     * Se trae el turno con su token en una sola consulta y se busca la
     * suscripción SIN filtrar por `activa`: si el turno se omitió por
     * timeout, el disparador la desactivó, y filtrar aquí haría que este
     * bloque no la encontrara nunca (era el fallo: el aviso «de llamada» no
     * se mandaba jamás después de un timeout). Se reactiva y se envía.
     */
    const { data: turno } = await supabase
      .from('turnos')
      .select('id, codigo, folio, token_publico, modulo_id, modulos(codigo)')
      .eq('id', turnoId)
      .maybeSingle()

    if (turno?.token_publico) {
      const { data: sub } = await supabase
        .from('suscripciones_push')
        .select('endpoint, clave_p256dh, clave_auth, activa')
        .eq('token_publico', turno.token_publico)
        .maybeSingle()

      if (sub) {
        if (!sub.activa) {
          await supabase
            .from('suscripciones_push')
            .update({ activa: true, ultima_activacion: null })
            .eq('token_publico', turno.token_publico)
        }

        const modulo = (turno as { modulos?: { codigo?: string } }).modulos?.codigo ?? null
        cola = [
          {
            turno_id: turno.id,
            endpoint: sub.endpoint,
            clave_p256dh: sub.clave_p256dh,
            clave_auth: sub.clave_auth,
            codigo_turno: turno.codigo,
            folio: turno.folio,
            modulo_codigo: modulo,
            tipo_aviso: 'LLAMADO',
            mensaje: `Su turno ${turno.codigo} fue llamado. Acuda a ${modulo ?? 'su módulo'}.`,
          },
        ]
      }
    }
  } else {
    const { data, error } = await supabase.rpc('suscripciones_por_notificar')
    if (error) {
      console.error('[situr/push] la cola falló:', error.message)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }
    cola = (data ?? []) as FilaCola[]
  }

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
        }),
        /*
         * TTL y urgencia (RFC 8030).
         *
         * El valor por defecto de `web-push` es un TTL de cuatro semanas y
         * una urgencia «normal». Con esos valores el proveedor de push
         * (Google) puede **aplazar la entrega**: guarda el aviso y lo
         * entrega la próxima vez que el navegador arranca. Eso es lo que se
         * veía en las pruebas: cerrando Chrome por completo, el aviso no
         * llegaba hasta que se volvía a abrir la aplicación.
         *
         * El TTL se acota a diez minutos porque es la ventana en la que el
         * aviso todavía sirve: un turno llamado se omite a los cinco minutos
         * (MINUTOS_TIMEOUT_LLAMADA), así que más tarde el aviso ya estaría
         * obsoleto. Y la urgencia «alta» pide entregarlo en cuanto haya red,
         * sin esperar a una ventana de mantenimiento.
         */
        { TTL: 600, urgency: 'high' },
      )

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

/*
 * Vercel (runtime de Node) no usa el valor que devuelve un `export
 * default`: hay que declarar cada método HTTP como export con nombre.
 * En desarrollo lo monta el plugin de Vite, que sí acepta el handler
 * suelto; el cuerpo y el comportamiento son los mismos.
 */
export const GET = handler
export const POST = handler
