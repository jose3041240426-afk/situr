import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

/**
 * SITUR — Emisor de notificaciones push (RF-028, DRS §6).
 *
 * Es la **única** pieza que envía Web Push. Se llama de dos maneras:
 *
 *   1. **Por el cron** (cada 5 minutos, GitHub Actions): recorre la cola de
 *      avisos y manda los que tocan (`suscripciones_por_notificar`).
 *   2. **Al llamar un turno**: la consola manda `?turno_id=...` con el token
 *      del operador, y se envía el aviso **en el acto**, sin esperar al cron.
 *      Es lo que hace que el ciudadano se entere en segundos y no en cinco
 *      minutos.
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

  // Autorización: cron (secreto) o operador (JWT de Supabase).
  const secreto = process.env.CRON_SECRET
  const esCron = Boolean(secreto && req.headers.get('authorization') === `Bearer ${secreto}`)
  let esOperador = false

  if (!esCron && turnoId && anonKey) {
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

  if (!esCron && !esOperador) {
    if (!secreto && process.env.NODE_ENV !== 'production') {
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
    const { data: turno } = await supabase
      .from('turnos')
      .select('id, codigo, folio, modulo_id, modulos(codigo)')
      .eq('id', turnoId)
      .maybeSingle()

    if (turno) {
      const { data: sub } = await supabase
        .from('suscripciones_push')
        .select('endpoint, clave_p256dh, clave_auth, activa')
        .eq('token_publico', (await supabase.from('turnos').select('token_publico').eq('id', turnoId).single()).data?.token_publico ?? '')
        .eq('activa', true)
        .maybeSingle()

      if (sub) {
      // La suscripción puede estar inactiva porque el turno se omitió por
      // timeout (5 min) y el disparador la desactivó. Si el ciudadano volvió
      // a abrir el portal, o el operador vuelve a llamar, se reactiva: el
      // aviso de «llamado» es más importante que el de «se omitió».
      if (!(sub as { activa?: boolean }).activa) {
        const { data: t2 } = await supabase
          .from('turnos').select('token_publico').eq('id', turnoId).single()
        if (t2?.token_publico) {
          await supabase
            .from('suscripciones_push')
            .update({ activa: true, ultima_activacion: null })
            .eq('token_publico', t2.token_publico)
        }
      }
        cola = [
          {
            turno_id: turno.id,
            endpoint: sub.endpoint,
            clave_p256dh: sub.clave_p256dh,
            clave_auth: sub.clave_auth,
            codigo_turno: turno.codigo,
            folio: turno.folio,
            modulo_codigo: (turno as { modulos?: { codigo?: string } }).modulos?.codigo ?? null,
            tipo_aviso: 'LLAMADO',
            mensaje: `Su turno ${turno.codigo} fue llamado. Acuda a ${(turno as { modulos?: { codigo?: string } }).modulos?.codigo ?? 'su módulo'}.`,
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
