/* eslint-env serviceworker */
/**
 * SITUR — Service Worker (RF-028).
 *
 * Su único trabajo es mostrar el aviso de Web Push aunque la pestaña esté
 * cerrada. **No guarda nada del turno**: el aviso lleva folio, código y
 * módulo, y nada más (DRS §5.2, «contenido mínimo del aviso»).
 *
 * EL DESTINO DEL AVISO
 * --------------------
 * Cuando el ciudadano toca el aviso hay que abrir **su** turno, y su turno
 * vive en `/turno/{token}`. Pero el token **no puede viajar en el aviso**:
 * el aviso pasa por el proveedor de push (Google, Apple), que es un tercero
 * y puede estar en otro país, y el DRS §5.2 lo prohíbe explícitamente
 * («ni token»). Mandar ahí un identificador es mandar una credencial a un
 * tercero.
 *
 * La salida: **el Service Worker guarda el token en su propio disco**
 * (IndexedDB), no en el aviso. El Service Worker es quien registra la
 * suscripción, y lo hace desde `/turno/{token}`, así que el token lo tiene a
 * mano en ese momento. Lo guarda, y al llegar el aviso lo usa para abrir el
 * portal. El token no sale del navegador del ciudadano en ningún momento.
 *
 * Esto no es una invención: es lo que hace todo el mundo que manda
 * notificaciones con Web Push y no quiere filtrar identificadores.
 *
 * El Service Worker NO se suscribe a ningún canal de Supabase ni consulta
 * nada: recibe lo que el navegador le entrega y lo muestra.
 */

const DB_SITUR = 'situr'
const ALMACEN = 'tokens'
const CLAVE_TOKEN = 'actual'

/* -------------------------------------------------------------------------- */
/* Almacén local del token                                                     */
/* -------------------------------------------------------------------------- */

function abrirBase() {
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(DB_SITUR, 1)
    peticion.onupgradeneeded = () => {
      const bd = peticion.result
      if (!bd.objectStoreNames.contains(ALMACEN)) bd.createObjectStore(ALMACEN)
    }
    peticion.onsuccess = () => resolver(peticion.result)
    peticion.onerror = () => rechazar(peticion.error)
  })
}

async function guardarToken(token) {
  const bd = await abrirBase()
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction(ALMACEN, 'readwrite')
    tx.objectStore(ALMACEN).put(token, CLAVE_TOKEN)
    tx.oncomplete = () => resolver(true)
    tx.onerror = () => rechazar(tx.error)
  })
}

async function leerToken() {
  const bd = await abrirBase()
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction(ALMACEN, 'readonly')
    const peticion = tx.objectStore(ALMACEN).get(CLAVE_TOKEN)
    peticion.onsuccess = () => resolver(peticion.result ?? null)
    peticion.onerror = () => rechazar(peticion.error)
  })
}

async function borrarToken() {
  const bd = await abrirBase()
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction(ALMACEN, 'readwrite')
    tx.objectStore(ALMACEN).delete(CLAVE_TOKEN)
    tx.oncomplete = () => resolver(true)
    tx.onerror = () => rechazar(tx.error)
  })
}

/**
 * Decide a dónde abre el aviso.
 *
 * **Una sola función para los dos usos**: el manejador del aviso y la
 * respuesta de diagnóstico. Si fueran dos copias, el diagnóstico podría
 * decir una cosa y el aviso hacer otra, y la comprobación no estaría
 * comprobando nada.
 */
async function destinoDelAviso() {
  const token = await leerToken().catch(() => null)
  // Sin token no hay portal que abrir: se cae a la pantalla pública, que
  // es lo único que un anónimo puede ver sin credencial.
  return token ? `/turno/${token}` : '/pantalla'
}

/* -------------------------------------------------------------------------- */
/* Ciclo de vida                                                                */
/* -------------------------------------------------------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/**
 * La página del portal (`/turno/{token}`) deja aquí su token.
 *
 * Se manda **siempre que se abre el portal**, no solo al suscribirse: si el
 * token se regenera (RF-007), el nuevo es el que vale, y si el ciudadano
 * vuelve a escanear el QR, este es el que se guarda.
 */
self.addEventListener('message', (event) => {
  const dato = event.data
  if (!dato || typeof dato !== 'object') return

  if (dato.tipo === 'guardar-token' && typeof dato.token === 'string' && dato.token) {
    event.waitUntil(guardarToken(dato.token).catch(() => undefined))
  } else if (dato.tipo === 'borrar-token') {
    event.waitUntil(borrarToken().catch(() => undefined))
  } else if (dato.tipo === 'destino' && event.ports && event.ports[0]) {
    /*
     * Diagnóstico: contesta dónde abriría el aviso. Existe para que se pueda
     * COMPROBAR (en el escaneo de comportamiento) que el aviso lleva al
     * turno del ciudadano y no a una página de error, en vez de suponerlo.
     * No tiene efecto en producción.
     */
    event.waitUntil(
      destinoDelAviso()
        .then((destino) => event.ports[0].postMessage({ destino }))
        .catch(() => event.ports[0].postMessage({ destino: '/pantalla' })),
    )
  }
})

/* -------------------------------------------------------------------------- */
/* El aviso                                                                     */
/* -------------------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let carga = {}
  try {
    carga = event.data ? event.data.json() : {}
  } catch {
    carga = {}
  }

  const titulo = carga.title || 'SITUR · Su turno'
  const cuerpo = carga.body || 'Su turno está próximo.'
  const folio = carga.codigo || ''

  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: cuerpo,
      icon: '/icono-192.png',
      badge: '/icono-192.png',
      tag: folio ? `situr-${folio}` : 'situr-turno',
      renotify: false,
      // El aviso NO lleva el token ni una URL: el destino lo resuelve este
      // Service Worker con lo que tiene guardado en local.
      data: { folio },
      vibrate: [120, 60, 120],
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  event.waitUntil(
    (async () => {
      const destino = await destinoDelAviso()

      const ventanas = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // Si el portal ya esta abierto, se reenfoca el portal. Antes se
      // navegaba la PRIMERA ventana que apareciera, que podia ser la
      // consola del operador o cualquier otra: el aviso del turno de un
      // ciudadano se abria en la ventana equivocada.
      const portal = ventanas.find((v) => v.url.includes('/turno/'))
      if (portal && 'focus' in portal) {
        await portal.focus()
        return
      }

      // Si hay alguna ventana abierta, se abre el destino en ella; si no,
      // se abre una nueva.
      const ventana = ventanas.find((v) => 'focus' in v)
      if (ventana && 'navigate' in ventana) {
        await ventana.navigate(destino)
        return ventana.focus()
      }
      return self.clients.openWindow(destino)
    })(),
  )
})
