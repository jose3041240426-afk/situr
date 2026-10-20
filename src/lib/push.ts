/**
 * SITUR — Cliente de notificaciones push (RF-028, DRS §5.2).
 *
 * El flujo que define el DRS, punto por punto:
 *
 *   1. El ciudadano escanea el QR y aterriza en /turno/{token}.
 *   2. Ve su turno con `get_turno_publico(token)`.
 *   3. **Solo entonces** la aplicación le pregunta si quiere el aviso.
 *   4. Si acepta, el Service Worker suscribe el navegador y se guardan
 *      endpoint + claves en `suscripciones_push`, ligadas a su token.
 *   5. Cuando el turno se acerca, `/api/push` avisa **con la pestaña cerrada**.
 *   6. Al cerrarse el turno, un disparador retira la suscripción.
 *
 * Regla que no se negocia: **el permiso nunca se pide en frío**. Pedirlo al
 * entrar al sitio, sin contexto, suele ser rechazado y hunde la tasa de
 * aceptación. Por eso la pregunta se hace DESPUÉS de haber pintado el turno.
 *
 * El alta y la baja NO van directas a Supabase: pasan por `/api/suscripcion`
 * para que el Edge Middleware pueda limitarlas por IP + token (DRS §10).
 */

const CLAVE_VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY

export type EstadoPermiso = 'default' | 'granted' | 'denied' | 'soportado' | 'no-soportado'

/** ¿El navegador puede recibir Web Push? */
export function pushSoportado(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function estadoPermiso(): EstadoPermiso {
  if (!pushSoportado()) return 'no-soportado'
  return Notification.permission as EstadoPermiso
}

/** Convierte la clave VAPID (base64url) al formato que espera `pushManager`. */
function vapidEnBytes(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalizado = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binario = atob(normalizado)
  const salida = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) salida[i] = binario.charCodeAt(i)
  return salida
}

/** Registra el Service Worker. Idempotente: se puede llamar varias veces. */
export async function registrarServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSoportado()) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch (e) {
    console.error('[situr] no se pudo registrar el Service Worker:', e)
    return null
  }
}

/**
 * Le deja al Service Worker el token del turno, para que sepa adónde abrir
 * el aviso.
 *
 * El token **no viaja en el aviso** (el DRS §5.2 lo prohíbe: el aviso pasa
 * por el proveedor de push, que es un tercero). Lo que viaja es una señal al
 * navegador del propio ciudadano, que lo guarda en su disco. Así, cuando
 * llegue el aviso, el Service Worker abre `/turno/{token}` sin que el token
 * haya salido de ese navegador.
 *
 * Se llama **siempre** que se abre el portal, no solo al suscribirse: si el
 * token se regenera (RF-007), el que vale es el nuevo.
 */
export async function recordarTokenEnElServiceWorker(token: string): Promise<void> {
  if (!pushSoportado() || !token) return
  try {
    const registro = await registrarServiceWorker()
    if (!registro) return
    await navigator.serviceWorker.ready
    const activo = registro.active ?? (await navigator.serviceWorker.ready).active
    activo?.postMessage({ tipo: 'guardar-token', token })
  } catch (e) {
    console.error('[situr] el Service Worker no guardó el token:', e)
  }
}

/**
 * Suscribe el navegador y da de alta la suscripción en la base.
 *
 * `UNIQUE(token_publico)` en `suscripciones_push` garantiza que reescanear el
 * QR **no** duplica avisos: la RPC actualiza la fila existente.
 */
export async function suscribirAvisos(token: string): Promise<boolean> {
  if (!pushSoportado()) return false
  if (!CLAVE_VAPID) {
    console.error('[situr] falta VITE_VAPID_PUBLIC_KEY: no se puede suscribir.')
    return false
  }

  const registro = await registrarServiceWorker()
  if (!registro) return false

  // `navigator.serviceWorker.ready` resuelve cuando el SW está activo.
  await navigator.serviceWorker.ready

  // Si ya había una suscripción para este navegador, se reutiliza: el
  // navegador devuelve el mismo `endpoint` para cualquier origen.
  let existente = await registro.pushManager.getSubscription()
  if (!existente) {
    existente = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidEnBytes(CLAVE_VAPID) as BufferSource,
    })
  }

  const json = existente.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false

  const respuesta = await fetch('/api/suscripcion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      endpoint: json.endpoint,
      clave_p256dh: json.keys.p256dh,
      clave_auth: json.keys.auth,
    }),
  })

  if (!respuesta.ok) {
    console.error('[situr] la base rechazó la suscripción:', respuesta.status)
    return false
  }
  return true
}

/** Da de baja la suscripción (el aviso ya no se manda por este navegador). */
export async function cancelarAvisos(token: string): Promise<void> {
  const registro = await registrarServiceWorker()
  if (registro) {
    const sub = await registro.pushManager.getSubscription()
    if (sub) await sub.unsubscribe()
    // El token guardado deja de servir para nada: se borra con el aviso.
    registro.active?.postMessage({ tipo: 'borrar-token' })
  }
  // Idempotente en la base: si no había nada, no falla.
  await fetch(`/api/suscripcion?token=${encodeURIComponent(token)}`, { method: 'DELETE' })
}

/** Pide el permiso del navegador. El diálogo lo abre el navegador, no la app. */
export async function pedirPermiso(): Promise<boolean> {
  if (!pushSoportado()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const permiso = await Notification.requestPermission()
  return permiso === 'granted'
}
