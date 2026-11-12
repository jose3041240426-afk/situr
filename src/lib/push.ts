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
    /*
     * `updateViaCache: 'none'` obliga a que el navegador descargue el
     * Service Worker del servidor en cada registro, en vez de servirlo desde
     * su propia caché HTTP. Sin esto, un móvil puede quedarse con una
     * versión antigua del Service Worker —incluida una que no sepa mostrar
     * el aviso— y los push se descartan en silencio: el servidor los manda,
     * el proveedor los acepta y en la pantalla no aparece nada.
     */
    return await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
  } catch (e) {
    console.error('[situr] no se pudo registrar el Service Worker:', e)
    return null
  }
}

/**
 * Pide al navegador que revise si hay una versión nueva del Service Worker.
 *
 * El Service Worker solo se actualiza cuando se registra uno nuevo, y el
 * registro solo ocurre al abrir el portal. Si el ciudadano no vuelve a abrir
 * la aplicación, el Service Worker que tiene instalado puede quedarse
 * viejo para siempre. Esto fuerza la revisión en cada apertura.
 */
export async function forzarActualizacionDelServiceWorker(): Promise<void> {
  if (!pushSoportado()) return
  try {
    const registro = await navigator.serviceWorker.getRegistration('/')
    if (registro) await registro.update()
  } catch (e) {
    console.error('[situr] no se pudo actualizar el Service Worker:', e)
  }
}

/**
 * Mantiene vivo al Service Worker mientras el portal está abierto.
 *
 * Chrome da de baja un Service Worker que lleva un rato sin actividad, y un
 * Service Worker dado de baja no puede recibir push: el navegador lo
 * desregistra y el proveedor de push ya no tiene a quién entregar. Mientras
 * la aplicación está en pantalla no tiene sentido que el Service Worker se
 * apague, así que se le pide una revisión cada veinte segundos.
 */
export function mantenerVivoElServiceWorker(): () => void {
  if (!pushSoportado()) return () => undefined
  const temporizador = setInterval(() => {
    void navigator.serviceWorker
      .getRegistration('/')
      .then((registro) => registro?.update())
      .catch(() => undefined)
  }, 20000)
  return () => clearInterval(temporizador)
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
