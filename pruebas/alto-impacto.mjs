#!/usr/bin/env node
/**
 * SITUR — Escaneo de accesibilidad de alto impacto (comportamiento).
 *
 * El escaneo estatico (axe sobre el DOM) NO ve lo que importa en una app con
 * dialogos: si el foco se escapa al cerrarlos, si hay una trampa de teclado, si
 * el contenido se desborda al estrecho, si el contraste se rompe al aplicarse
 * la cascada completa, o si un estado revelado por un boton es inaccesible.
 *
 * Eso es lo que mide este escaneo, con el mismo enfoque que el paquete
 * `Community-Access/accessibility-agents` (teclado, viewports, contraste
 * calculado y arbol de accesibilidad), corregido en dos puntos:
 *
 *   1. La pagina recibe el foco antes de tabular. Sin eso, `Tab` se queda en
 *      <body> y toda pagina parece una trampa de teclado.
 *   2. "No hay ningun elemento enfocable" NO es una trampa: es una pagina
 *      estatica (la pantalla publica). Solo es trampa si HAY elementos
 *      enfocables y el foco no llega a ninguno.
 *
 * Ademas espera a que la aplicacion termine de montar antes de medir: con la
 * sesion caducada, la consola muestra "Cargando..." y no tiene nada que
 * enfocar.
 *
 * Uso:
 *   node pruebas/alto-impacto.mjs [--url=http://127.0.0.1:5173] [--token=abc]
 *                                [--correo=admin@situr.local] [--clave=...]
 *
 * Salida: 0 si no hay hallazgos, 1 si los hay, 2 si no se pudo evaluar.
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')

const arg = (n, d) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d

const urlBase = arg('url', 'http://127.0.0.1:5173')
const tokenPrueba = arg('token', leerEnv('TOKEN_PRUEBA'))
const correo = arg('correo', leerEnv('SITUR_ADMIN_EMAIL') ?? 'admin@situr.local')
const clave = arg('clave', leerEnv('SITUR_ADMIN_PASSWORD') ?? 'situr-admin-2026')

function leerEnv(clave) {
  try {
    const env = readFileSync(path.join(raiz, '.env.local'), 'utf8')
    const m = env.match(new RegExp(`^${clave}=(.*)$`, 'm'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function rutaChromium() {
  for (const c of [
    process.env.CHROME_PATH,
    '/home/manuelg/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].filter(Boolean)) {
    if (existsSync(c)) return c
  }
  return null
}

const chrome = rutaChromium()
if (!chrome) {
  console.error('No hay Chromium. Define CHROME_PATH.')
  process.exit(2)
}

const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

const PANTALLAS = [
  { ruta: '/admin', nombre: 'Login' },
  { ruta: '/admin/turnos', nombre: 'Consola' },
  { ruta: '/admin/historial', nombre: 'Historial' },
  { ruta: '/admin/usuarios', nombre: 'Usuarios' },
  { ruta: '/admin/catalogos', nombre: 'Catálogos' },
  { ruta: '/admin/estadisticas', nombre: 'Estadísticas' },
  { ruta: '/pantalla', nombre: 'Pantalla pública' },
]
if (tokenPrueba) {
  PANTALLAS.push({ ruta: `/turno/${tokenPrueba}`, nombre: 'Portal del ciudadano' })
}

const VIEWPORTS = [320, 768, 1024, 1440]

console.log('SITUR — escaneo de alto impacto (comportamiento)')
console.log('='.repeat(62))
console.log(`Aplicación: ${urlBase}`)
console.log('')

const navegador = await chromium.launch({
  executablePath: chrome,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Con 8 GB y `vm.overcommit_memory` en 0, el kernel mata el renderizador
    // y Playwright ve «Target crashed». Un solo proceso de render y un
    // limite de memoria para el JS lo evitan.
    '--renderer-process-limit=1',
    '--js-flags=--max-old-space-size=384',
  ],
})
const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 } })

let CON_SESION = false

// --- Sesion, para que la consola se pueda medir de verdad ------------------
try {
  const paginaLogin = await contexto.newPage()
  await paginaLogin.goto(`${urlBase}/admin`, { waitUntil: 'domcontentloaded' })
  await paginaLogin.waitForTimeout(1500)
  if (await paginaLogin.locator('input[type=email]').count()) {
    await paginaLogin.fill('input[type=email]', correo)
    await paginaLogin.fill('input[type=password]', clave)
    await paginaLogin.click('button[type=submit]')
    await paginaLogin.waitForTimeout(2500)
    // Si pide MFA, se inscribe con el codigo de prueba del arnés.
    if (await paginaLogin.locator('text=Configurar ahora').count()) {
      await paginaLogin.click('text=Configurar ahora')
      await paginaLogin.waitForTimeout(1500)
      const campo = paginaLogin.locator('input[inputmode=numeric]')
      if (await campo.count()) {
        await campo.fill(arg('mfa', '123456'))
        await paginaLogin.click('text=Verificar y continuar')
        await paginaLogin.waitForTimeout(3500)
      }
    }
    console.log('Sesión iniciada.')
  }
  await paginaLogin.close()
  CON_SESION = true
} catch (e) {
  console.log(
    `Aviso: no se pudo iniciar sesión (${e.message.split('\n')[0]}).\n` +
      '        Las pantallas de la consola se evaluarán sin sesión: eso NO es\n' +
      '        el estado real de uso, y el escaneo de ellas no es válido.',
  )
}

const hallazgos = []

for (const pantalla of PANTALLAS) {
  const url = `${urlBase}${pantalla.ruta}`
  const pagina = await contexto.newPage()
  const h = { pantalla: pantalla.nombre, url, problemas: [] }

  try {
    // --- 1. AXE (estatico) ---------------------------------------------
    await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await pagina.waitForTimeout(2500)
    await pagina.addScriptTag({ content: axe })
    const axeViolations = await pagina.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ['violations'] })
      return r.violations.map((v) => ({
        id: v.id,
        impacto: v.impact,
        nodos: v.nodes.length,
        ejemplo: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
        mensaje: v.nodes[0]?.any?.[0]?.message ?? '',
      }))
    })
    if (axeViolations.length) {
      h.problemas.push({
        tipo: 'axe',
        detalle: axeViolations.map((v) => `${v.id} (${v.impacto}): ${v.mensaje.slice(0, 110)}`),
      })
    }

    // --- 2. FLUJO DE TECLADO -------------------------------------------
    await pagina.bringToFront()
    await pagina.evaluate(() => {
      document.body.setAttribute('tabindex', '-1')
      document.body.focus()
    })
    await pagina.waitForTimeout(300)

    const enfocables = await pagina.evaluate(() =>
      document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), ' +
          'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ).length,
    )

    const paradas = []
    for (let i = 0; i < 60; i++) {
      await pagina.keyboard.press('Tab')
      const actual = await pagina.evaluate(() => {
        const el = document.activeElement
        if (!el) return 'ninguno'
        if (el === document.body) return 'body'
        const et = el.getAttribute('aria-label') || el.textContent || ''
        return `${el.tagName.toLowerCase()}:${et.trim().slice(0, 26)}`
      })
      paradas.push(actual)
    }

    const distintas = [...new Set(paradas.filter((p) => p !== 'body'))]
    const trampa =
      enfocables > 0 && distintas.length === 0
        ? 'hay elementos enfocables y el Tab no llega a ninguno'
        : null

    if (trampa) h.problemas.push({ tipo: 'trampa-teclado', detalle: [trampa] })
    if (enfocables === 0) {
      h.nota = 'página sin elementos interactivos: no aplica la prueba de teclado'
    }

    // --- 2b. LA PANTALLA PÚBLICA TIENE QUE MOSTRAR LAS LLAMADAS ---------
    //
    // Guarda contra un fallo que ya ocurrió: la pantalla pedía la vista
    // de turnos en curso directamente al navegador, la RLS se lo negaba, y
    // la pantalla se quedaba SIEMPRE en «Espere a que se llamen los
    // turnos» sin que nada dijera que era un permiso denegado. El
    // escaneo de accesibilidad no lo detecta: una pantalla vacía es
    // perfectamente accesible.
    if (pantalla.nombre === 'Pantalla pública') {
      const api = await pagina.evaluate(async () => {
        const r = await fetch('/api/ultimas-llamadas?limite=8')
        return r.ok ? r.json() : { llamadas: [] }
      })
      const hayLlamadas = (api.llamadas ?? []).length > 0
      const texto = await pagina.evaluate(() => document.body.innerText)
      const esperando = texto.includes('Espere a que se llamen')
      if (hayLlamadas && esperando) {
        h.problemas.push({
          tipo: 'pantalla-vacia',
          detalle: [
            `la API devuelve ${api.llamadas.length} llamadas, pero la pantalla ` +
              'muestra el estado vacío',
          ],
        })
      }
      if (hayLlamadas) {
        const primera = api.llamadas[0].codigo_turno
        if (!texto.includes(primera)) {
          h.problemas.push({
            tipo: 'pantalla-vacia',
            detalle: [`la pantalla no muestra la llamada ${primera}`],
          })
        }
      }
    }

    // --- 2c. EL AVISO PUSH TIENE QUE LLEVAR AL TURNO DEL CIUDADANO ------
    //
    // Guarda contra un fallo que ya ocurrió: el aviso mandaba
    // `/turno/{turno_id}` (un UUID) en una ruta que espera el token, así que
    // el ciudadano tocaba su aviso y le abría una página de error. Y el
    // arreglo NO puede ser mandar el token en el aviso (el DRS §5.2 lo
    // prohíbe: el aviso pasa por el proveedor de push, que es un tercero).
    // Lo resuelve el Service Worker, con el token guardado en su disco.
    if (pantalla.nombre === 'Portal del ciudadano' && tokenPrueba) {
      const sw = await pagina.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return { error: 'sin service worker' }
        const reg = await navigator.serviceWorker.ready
        if (!reg.active) return { error: 'service worker inactivo' }

        // Hay que forzar la actualizacion: si no, el navegador sigue con la
        // version anterior del `sw.js` cacheada y la comprobacion no estaria
        // mirando el codigo de disco, sino el de la vez anterior.
        await reg.update().catch(() => undefined)
        await new Promise((resolver) => {
          if (!reg.installing && !reg.waiting) return resolver()
          const listo = () => {
            const w = reg.installing ?? reg.waiting
            if (w && (w.state === 'activated' || w.state === 'redundant')) resolver()
          }
          reg.addEventListener('updatefound', listo)
          setTimeout(resolver, 5000)
        })
        await new Promise((r) => setTimeout(r, 800))

        return await new Promise((resolver) => {
          const canal = new MessageChannel()
          const t = setTimeout(() => resolver({ error: 'sin respuesta' }), 5000)
          canal.port1.onmessage = (e) => {
            clearTimeout(t)
            resolver({ destino: e.data?.destino ?? null })
          }
          reg.active.postMessage({ tipo: 'destino' }, [canal.port2])
        })
      })
      if (sw.error) {
        h.problemas.push({ tipo: 'aviso-push', detalle: [sw.error] })
      } else if (sw.destino !== `/turno/${tokenPrueba}`) {
        h.problemas.push({
          tipo: 'aviso-push',
          detalle: [
            `el aviso abriria ${sw.destino} y deberia abrir /turno/${tokenPrueba?.slice(0, 8)}…`,
          ],
        })
      } else {
        // Y ese destino tiene que devolver el turno de verdad, no un error.
        const abre = await pagina.evaluate(async (destino) => {
          const r = await fetch('/api/turno?token=' + destino.replace('/turno/', ''))
          const j = await r.json().catch(() => ({}))
          return { status: r.status, ok: j.ok === true }
        }, sw.destino)
        if (!abre.ok) {
          h.problemas.push({
            tipo: 'aviso-push',
            detalle: [`el destino del aviso no devuelve un turno (HTTP ${abre.status})`],
          })
        }
      }
    }

    // --- 3. VIEWPORTS: reflow y scroll horizontal -------------------------
    for (const ancho of VIEWPORTS) {
      await pagina.setViewportSize({ width: ancho, height: 900 })
      await pagina.waitForTimeout(500)
      const r = await pagina.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        cliente: document.documentElement.clientWidth,
      }))
      if (r.scroll > r.cliente + 1) {
        h.problemas.push({
          tipo: 'desborde-horizontal',
          detalle: [`${ancho}px: contenido ${r.scroll}px > ventana ${r.cliente}px`],
        })
      }
    }
    await pagina.setViewportSize({ width: 1440, height: 900 })

    // --- 4. CONTRASTE CALCULADO (tras la cascada completa) ----------------
    const contrastes = await pagina.evaluate(() => {
      const lum = (c) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const ratio = (a, b) => {
        const l1 = lum(a)
        const l2 = lum(b)
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      }
      const parse = (s) => {
        const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
        return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null
      }
      const fondoDe = (el) => {
        let n = el
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor)
          if (c && c[3] > 0.9) return c.slice(0, 3)
          n = n.parentElement
        }
        return [255, 255, 255]
      }
      const malos = []
      for (const el of document.querySelectorAll('p,span,a,button,td,th,li,label,h1,h2,h3,h4,summary,dd,dt')) {
        if (!el.textContent?.trim()) continue
        if (el.children.length > 0 && el.textContent.trim() !== el.firstChild?.textContent?.trim()) continue
        const s = getComputedStyle(el)
        if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue
        const fg = parse(s.color)
        if (!fg) continue
        const bg = fondoDe(el)
        const tam = parseFloat(s.fontSize)
        const peso = +s.fontWeight || 400
        const grande = tam >= 24 || (tam >= 18.66 && peso >= 700)
        const minimo = grande ? 3 : 4.5
        const r = ratio(fg.slice(0, 3), bg)
        if (r < minimo) {
          malos.push(
            `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}: ` +
              `${r.toFixed(2)}:1 (min ${minimo}) "${el.textContent.trim().slice(0, 40)}"`,
          )
        }
      }
      return malos
    })
    if (contrastes.length) {
      h.problemas.push({ tipo: 'contraste', detalle: contrastes.slice(0, 8) })
    }

    // --- 5. ARBOL DE ACCESIBILIDAD: landmarks y encabezados ---------------
    const arbol = await pagina.evaluate(() => ({
      landmarks: [...document.querySelectorAll('header,nav,main,footer,aside,[role]')].map(
        (e) => `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''}`,
      ),
      encabezados: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(
        (h) => `${h.tagName}:${h.textContent.trim().slice(0, 24)}`,
      ),
      h1: document.querySelectorAll('h1').length,
      main: document.querySelectorAll('main').length,
      vive: [...document.querySelectorAll('[aria-live],[role=status],[role=alert]')].length,
    }))
    h.estructura = arbol
    if (arbol.h1 !== 1) {
      h.problemas.push({
        tipo: 'encabezado-h1',
        detalle: [`la página tiene ${arbol.h1} elementos <h1> (debería tener 1)`],
      })
    }
    if (arbol.main !== 1) {
      h.problemas.push({
        tipo: 'landmark-main',
        detalle: [`la página tiene ${arbol.main} elementos <main> (debería tener 1)`],
      })
    }
  } catch (e) {
    h.problemas.push({ tipo: 'error', detalle: [e.message.split('\n')[0]] })
  } finally {
    await pagina.close()
  }

  if (h.problemas.length === 0) {
    console.log(`  OK   ${pantalla.nombre}`)
  } else {
    console.log(`  FALLA ${pantalla.nombre}`)
    for (const p of h.problemas) {
      console.log(`         · ${p.tipo}`)
      for (const d of p.detalle) console.log(`           ${d}`)
    }
  }
  hallazgos.push(h)
}

await navegador.close()

const conProblemas = hallazgos.filter((h) => h.problemas.length > 0)
const salida = '/tmp/situr-alto-impacto.json'
mkdirSync(path.dirname(salida), { recursive: true })
writeFileSync(salida, JSON.stringify(hallazgos, null, 2))

console.log('')
console.log('='.repeat(62))
console.log(`${conProblemas.length} de ${hallazgos.length} pantallas con hallazgos.`)
if (!CON_SESION) {
  console.log(
    'Aviso: el escaneo corrió SIN sesión. Las pantallas del panel se midieron\n' +
      '        en un estado que no es el real; para un resultado válido hace\n' +
      '        falta que el login funcione.',
  )
}
console.log(`Detalle: ${salida}`)
process.exit(conProblemas.length > 0 ? 1 : 0)
