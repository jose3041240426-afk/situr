#!/usr/bin/env node
/**
 * SITUR — Recorrido guiado con capturas (tutorial).
 *
 * Recorre el sistema **de verdad**, como lo usaría un operador y un
 * ciudadano, y fotografía cada paso. No simula nada: cada captura es una
 * pantalla real, con los datos que el sistema acaba de crear.
 *
 * Qué deja:
 *   ../tutorial/capturas/NN-slug.png   una imagen por paso
 *   ../tutorial/pasos.json              el manifiesto (titulo, texto, archivo)
 *   ../tutorial/TUTORIAL.md             el tutorial
 *   ../tutorial/TUTORIAL.pdf            el tutorial en PDF
 *
 * El PDF pone el texto a la izquierda y la imagen a la derecha, DOS pasos
 * por hoja, y cada paso entero en una sola hoja: la descripción y su
 * imagen nunca quedan separadas.
 *
 * Uso:
 *   pruebas/tutorial.sh [base]      # levanta el stack limpio y ejecuta esto
 *   node pruebas/tutorial.mjs [--url=...] [--base=...]
 *
 * Notas:
 *   * El sondeo del portal del ciudadano es de 10 s (el camino rápido es
 *     Realtime, que no existe en el arnés local), así que hay que esperar
 *     a que se repinte.
 *   * El aviso push **no** se puede probar aquí: haría falta un VAPID
 *     real y un push service. Se documenta el paso, no se finge la captura.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')
const proyecto = path.resolve(raiz, '..')

const arg = (n, d) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d

const urlBase = arg('url', 'http://127.0.0.1:5173')
const baseDatos = arg('base', 'situr_tutorial')
const destino = path.resolve(arg('carpeta', path.join(proyecto, 'tutorial')))
const capturas = path.join(destino, 'capturas')

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

const correo = leerEnv('SITUR_ADMIN_EMAIL') ?? 'admin@situr.local'
const clave = leerEnv('SITUR_ADMIN_PASSWORD') ?? 'situr-admin-2026'

/*
 * El recorrido tiene que empezar de una base limpia: si ya hay un periodo
 * abierto o turnos emitidos, faltan pasos (el MFA no se pide dos veces, el
 * periodo no se abre dos veces) y las capturas no cuentan lo que dicen que
 * cuentan. Se comprueba y se dice, en vez de sacar un tutorial incompleto
 * sin avisar.
 */
function consultar(sql) {
  return execFileSync('psql', ['-X', '-tAqc', sql, '-d', baseDatos], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PGHOST: process.env.PGHOST ?? '127.0.0.1',
      PGUSER: process.env.PGUSER ?? 'postgres',
    },
  }).trim()
}

const turnosPrevios = Number(consultar('SELECT count(*) FROM turnos'))
const periodosAbiertos = Number(
  consultar("SELECT count(*) FROM periodos_operativos WHERE estado = 'ABIERTO'"),
)
if (turnosPrevios > 0 || periodosAbiertos > 0) {
  console.error(
    `\nLa base '${baseDatos}' no está limpia (${turnosPrevios} turnos, ` +
      `${periodosAbiertos} periodos abiertos).\n` +
      'El tutorial tiene que empezar de cero; con datos de antes faltan pasos ' +
      'y las capturas no cuentan lo que dicen que cuentan.\n\n' +
      `    cd app && pruebas/tutorial.sh ${baseDatos}\n\n` +
      'Eso levanta el stack con la base recién migrada y vacía, y ejecuta el\n' +
      'recorrido.\n',
  )
  process.exit(3)
}

mkdirSync(capturas, { recursive: true })

const pasos = []
let n = 0

const navegador = await chromium.launch({
  executablePath: chrome,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // En una maquina con 8 GB y varios navegadores abiertos, el renderizador
    // de Chromium se queda sin memoria y revienta («Target crashed») a la
    // hora de capturar. Con el software rasterizado y sin extensiones aguanta.
    '--disable-gpu',
    // La maquina tiene 8 GB y `vm.overcommit_memory` esta en 0: cuando el
    // kernel no puede sobrecomprometer, mata el renderizador de Chromium y
    // Playwright ve «Target crashed». Con un solo proceso de render y un
    // limite de堆 para JS, el navegador aguanta.
    '--renderer-process-limit=1',
    '--js-flags=--max-old-space-size=384',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
  ],
})

/*
  Dos contextos: el del operador (escritorio) y el del ciudadano (teléfono).

  El del móvil se crea **cuando hace falta** y se cierra al terminar. En una
  máquina con 8 GB tener los dos abiertos a la vez multiplica los
  renderizadores de Chromium, y el kernel acaba matándolos («Target
  crashed»): es un problema de memoria, no del código.
*/
const escritorio = await navegador.newContext({
  /*
    1280x800 y escala 1. A 1440x900 con escala 2 (2880x1800) el rasterizador
    de Chromium se queda sin memoria en esta máquina y el renderizador
    muere a mitad del recorrido («Target crashed»). Para el PDF da igual: la
    imagen se escala al ancho de la página.
  */
  viewport: { width: 1280, height: 800 },
  /*
    Escala 1, no 2. A 2880x1800 el rasterizador de Chromium se queda sin
    memoria en esta máquina y la captura falla con «Unable to capture
    screenshot». Para el PDF da igual: la imagen se escala al ancho de la
    página. El móvil sí va a escala 2, que a 780x1688 aguanta.
  */
  deviceScaleFactor: 1,
})
let contextoMovil = null
const movil = async () => {
  if (!contextoMovil) {
    contextoMovil = await navegador.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
  }
  return contextoMovil
}

/**
 * Marca un elemento sobre la propia captura: un recuadro rosa con una
 * etiqueta debajo.
 *
 * Sirve para que el lector sepa **qué hay que pulsar** sin tener que
 * buscarlo: la foto enseña la pantalla real, con el botón rodeado. El
 * color no es de la paleta de la aplicación a propósito: es una anotación
 * de un tutorial, y no tiene que confundirse con nada de la interfaz.
 */
async function marcar(pagina, objetivo, etiqueta) {
  const caja = await objetivo.boundingBox()
  if (!caja) return
  await pagina.evaluate(
    ({ x, y, w, h, texto }) => {
      document.getElementById('__situr_marca')?.remove()

      // Los dos van dentro de un contenedor, para que al quitar las marcas
      // se quiten las dos cosas: si el rotulo se queda, se ve el rotulo del
      // paso anterior en la foto siguiente.
      const contenedor = document.createElement('div')
      contenedor.id = '__situr_marca'
      contenedor.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;'

      const marco = document.createElement('div')
      marco.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `box-sizing:border-box;border:3px solid #ff2d55;border-radius:10px;` +
        `box-shadow:0 0 0 5px rgba(255,45,85,.22);`

      const rotulo = document.createElement('div')
      rotulo.textContent = texto
      const arriba = y > 34
      rotulo.style.cssText =
        `position:fixed;left:-9999px;` +
        `top:${arriba ? y - 30 : y + h + 8}px;max-width:240px;` +
        `background:#ff2d55;color:#fff;font:600 13px/1.35 system-ui,sans-serif;` +
        `padding:4px 10px;border-radius:6px;` +
        `box-shadow:0 2px 10px rgba(0,0,0,.3);`

      contenedor.appendChild(marco)
      contenedor.appendChild(rotulo)
      document.body.appendChild(contenedor)

      // El rotulo se mide y se alinea a la DERECHA del elemento: alineado a
      // la izquierda tapaba el texto que hay encima (el codigo del turno, el
      // titulo del panel…) y la foto quedaba sucia.
      const ancho = rotulo.offsetWidth
      const izquierda = Math.max(4, Math.min(x + w - ancho, window.innerWidth - ancho - 4))
      rotulo.style.left = `${izquierda}px`
    },
    { x: caja.x, y: caja.y, w: caja.width, h: caja.height, texto: etiqueta },
  )
}

async function quitarMarcas(pagina) {
  await pagina.evaluate(() => document.getElementById('__situr_marca')?.remove())
}

/**
 * Fotografía un paso.
 *
 * `debeVerse` es el texto que TIENE que estar en la pantalla. Sin esta
 * comprobación, una captura puede salir en blanco: en desarrollo la
 * primera carga tarda en montar, y una foto de una página vacía es una
 * foto que no enseña nada. Si el texto no aparece, es un fallo del
 * recorrido, no una foto rara.
 */
async function capturar(pagina, slug, titulo, texto, debeVerse, marcas = []) {
  if (debeVerse) {
    try {
      await pagina.getByText(debeVerse, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: 25000,
      })
    } catch (e) {
      /*
        Reintento con recarga.

        Hay dos motivos por los que esto falla de verdad:

        1. `levantar.sh` reescribe `.env.local`, y eso reinicia el servidor
           de desarrollo. Si la pagina se carga mientras Vite se reinicia, se
           queda a medio autenticar y aparece el aviso de «no tiene
           permiso para operar».
        2. En una maquina con 8 GB el renderizador de Chromium se queda sin
           memoria a veces («Target crashed»).

        En los dos casos, recargar y esperar otra vez lo arregla; y es
        preferible a que el tutorial entero se caiga.
      */
      for (let intento = 1; intento <= 3; intento++) {
        await pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
        await espera(3000)
        try {
          await pagina.getByText(debeVerse, { exact: false }).first().waitFor({
            state: 'visible',
            timeout: 20000,
          })
          break
        } catch (e2) {
          if (intento === 3) {
            const texto = await pagina
              .evaluate(() => document.body?.innerText?.slice(0, 300) ?? '')
              .catch(() => '(no se pudo leer la pagina)')
            throw new Error(
              `El paso «${titulo}» no muestra «${debeVerse}».\n` +
                `      Lo que si se ve: ${texto.replace(/\n/g, ' | ')}`,
            )
          }
        }
      }
    }
    try {
      await pagina.getByText(debeVerse, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: 25000,
      })
    } catch {
      // Que el error diga QUE se ve: si no, solo dice que falta un texto y
      // no hay por dónde empezar.
      const texto = await pagina
        .evaluate(() => document.body?.innerText?.slice(0, 400) ?? '')
        .catch(() => '(no se pudo leer la pagina)')
      throw new Error(
        `El paso «${titulo}» no muestra «${debeVerse}»: la captura saldría en blanco.\n` +
          `      Lo que si se ve: ${texto.replace(/\n/g, ' | ')}`,
      )
    }
  }
  n += 1
  const archivo = `${String(n).padStart(2, '0')}-${slug}.png`
  for (const [objetivo, etiqueta] of marcas) await marcar(pagina, objetivo, etiqueta)
  // La captura se reintenta: si el renderizador se queda sin memoria a
  // media foto, antes que dejar el tutorial a medias se prueba otra vez.
  let capturada = false
  for (let intento = 1; intento <= 4 && !capturada; intento++) {
    try {
      await pagina.screenshot({
        path: path.join(capturas, archivo),
        fullPage: false,
        timeout: 25000,
      })
      capturada = true
    } catch (e) {
      if (intento === 4) throw e
      await espera(1500)
    }
  }
  await quitarMarcas(pagina)
  pasos.push({ n, archivo, titulo, texto })
  console.log(`  ${String(n).padStart(2, '0')}  ${titulo}`)
  return archivo
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Pulsa un boton esperando a que exista. Si no aparece, el error dice QUE
 * se ve en pantalla: si no, uno se queda mirando un timeout sin pistas.
 */
async function pulsar(pagina, texto) {
  const boton = pagina.locator(`button:has-text("${texto}")`).first()
  try {
    await boton.waitFor({ state: 'visible', timeout: 25000 })
    await boton.click()
  } catch (e) {
    const visto = await pagina
      .evaluate(() => document.body?.innerText?.slice(0, 300) ?? '')
      .catch(() => '(no se pudo leer la pagina)')
    throw new Error(
      `No se pudo pulsar «${texto}».\n      Lo que si se ve: ${visto.replace(/\n/g, ' | ')}`,
    )
  }
}

/**
 * Abre una ruta y espera a que la aplicacion este montada de verdad.
 *
 * `levantar.sh` reescribe `.env.local`, y eso hace que Vite se reinicie
 * solo. Si la primera carga cae en mitad de ese reinicio, la pagina se
 * queda en blanco y la captura sale vacia. Por eso se reintenta: no se
 * photographia una pagina a medio montar.
 */
async function abrir(pagina, ruta) {
  for (let intento = 1; intento <= 4; intento++) {
    await pagina.goto(`${urlBase}${ruta}`, { waitUntil: 'domcontentloaded' })
    try {
      await pagina.waitForFunction(
        () => {
          const raiz = document.getElementById('root')
          return !!raiz && raiz.children.length > 0
        },
        { timeout: 12000 },
      )
      return
    } catch {
      if (intento === 4) {
        throw new Error(`La aplicacion no montó en ${ruta} tras 4 intentos.`)
      }
      await espera(1500)
    }
  }
}

// ===========================================================================
// 1. El operador entra
// ===========================================================================
console.log('\nSITUR — recorrido guiado\n' + '='.repeat(62))

const op = await escritorio.newPage()
await abrir(op, '/admin')
await capturar(
  op,
  'acceso',
  'El acceso del operador',
  'Se escribe el **correo institucional** y la **contraseña**, y se pulsa ' +
    '**«Entrar»**. El sistema no es público: sin una cuenta con rol, no se ' +
    've ni un solo turno.',
  'Correo institucional',
  [[op.locator('button[type=submit]'), '«Entrar»']],
)

await op.fill('input[type=email]', correo)
await op.fill('input[type=password]', clave)
await op.waitForTimeout(400)
await op.click('button[type=submit]')
await op.waitForTimeout(3000)

if (await op.locator('text=Configurar ahora').count()) {
  await capturar(
    op,
    'mfa',
    'La verificación en dos pasos',
    'La primera vez hay que inscribir el segundo factor: se pulsa ' +
      '**«Configurar ahora»**, se escanea el QR con la aplicación de ' +
      'autenticación y se teclea el código de seis dígitos. A partir de ' +
      'ahí, cada acceso pide ese código además de la contraseña: una ' +
      'contraseña robada no basta para emitir turnos.',
    'Configurar ahora',
    [[op.locator('text=Configurar ahora'), '«Configurar ahora»']],
  )
  await op.click('text=Configurar ahora')
  await op.waitForTimeout(1800)
  await op.fill('input[inputmode=numeric]', '123456')
  await op.click('text=Verificar y continuar')
  await op.waitForTimeout(4000)
}

await abrir(op, '/admin/turnos')
await capturar(
  op,
  'consola',
  'La consola del operador',
  'Aquí ocurre todo el trabajo del día: emitir, llamar, atender. La ' +
    'columna izquierda emite; la derecha, llama. Abajo, la cola.',
  'PERIODO OPERATIVO',
)

// ===========================================================================
// 2. Abrir el periodo
// ===========================================================================
const botonAbrir = op.locator('button:has-text("Abrir periodo de hoy")')
if (await botonAbrir.count()) {
  // Se espera a que la consola haya cargado de verdad: pulsar antes de que
  // lleguen los datos no abre el periodo.
  await op.getByText('PERIODO OPERATIVO').first().waitFor({ state: 'visible', timeout: 25000 })
  await botonAbrir.click()
  await op.getByText('Cerrar periodo').first().waitFor({ state: 'visible', timeout: 25000 })
  await op.waitForTimeout(1200)
  await capturar(
    op,
    'periodo',
    'Abrir el periodo operativo',
    'Se pulsa **«Abrir periodo de hoy»**. Sin un periodo abierto la base ' +
      'rechaza cualquier alta de turno. El periodo es el día de trabajo: al ' +
      'cerrarlo, los turnos que queden en espera pasan a omitidos.',
    'Cerrar periodo',
    [[op.locator('button:has-text("Cerrar periodo")'), 'el periodo, ya abierto']],
  )
}

// ===========================================================================
// 3. Emitir un turno y ver el boleto
// ===========================================================================
await op.selectOption('select.selector', { index: 0 }).catch(() => {})
await op.waitForTimeout(300)
await pulsar(op, 'Emitir turno')
await op.waitForTimeout(2800)
await capturar(
  op,
  'emitir',
  'Emitir un turno',
  'Se elige el **trámite** y la **prioridad**, y se pulsa **«Emitir ' +
    'turno»**. La base numera el folio de forma atómica, así que dos ' +
    'ventanillas simultáneas no reparten el mismo número.',
  'TURNO EMITIDO',
  [[op.locator('img[alt^="Código QR"]'), 'el QR que sale al emitir']],
)

const token = (
  await op
    .locator('img[alt^="Código QR"]')
    .locator('xpath=following-sibling::p[1]')
    .innerText()
).trim()
const codigoTurno = (await op.locator('p.text-2xl.font-black').first().innerText()).trim()
console.log(`      turno ${codigoTurno}, token ${token.slice(0, 12)}…`)

// El boleto como se imprime.
await op.emulateMedia({ media: 'print' })
await op.waitForTimeout(600)
await capturar(
  op,
  'boleto',
  'El boleto que se lleva el ciudadano',
  'Con el boleto en pantalla se pulsa **«Imprimir»**. Sale **solo el ' +
    'boleto**: ni la consola, ni la cola de los demás. El QR apunta a ' +
    '/turno/{token} y no lleva ningún dato del ciudadano; el código es su ' +
    'credencial, y la nota lo dice.',
  'Turno emitido',
  [[op.locator('img[alt^="Código QR"]'), 'el QR que se entrega']],
)
await op.emulateMedia({ media: 'screen' })
await op.waitForTimeout(400)

// ===========================================================================
// 4. El ciudadano escanea el QR
// ===========================================================================
const ciudad = await (await movil()).newPage()
await abrir(ciudad, `/turno/${token}`)
await capturar(
  ciudad,
  'ciudadano',
  'El ciudadano escanea el QR',
  'Al escanear el QR, el teléfono abre el portal y aparece el **código ' +
    'de turno**. **No hay cuenta, ni registro, ni correo, ni teléfono**: el ' +
    'token del QR es la única credencial, y solo mientras el turno siga ' +
    'vivo.',
  'SU TURNO',
  [[ciudad.locator('h1.text-5xl').first(), 'su código']],
)

await ciudad.locator('summary:has-text("Aviso de privacidad")').click()
await ciudad.waitForTimeout(900)
await capturar(
  ciudad,
  'privacidad',
  'El aviso de privacidad, a la vista',
  'Se despliega **«Aviso de privacidad»** y se lee: explica con lo que el ' +
    'sistema cumple de verdad qué se guarda, durante cuánto, quién es el ' +
    'tercero cuando se aceptan los avisos y cómo se retira el permiso.',
  'Aviso de privacidad',
  [[ciudad.locator('summary:has-text("Aviso de privacidad")'), '«Aviso de privacidad»']],
)
await ciudad.locator('summary:has-text("Aviso de privacidad")').click()
await ciudad.waitForTimeout(500)

// ===========================================================================
// 5. El operador llama a un turno
// ===========================================================================
await abrir(op, '/admin/turnos')
await op.waitForTimeout(2500)
// La propuesta se ve ANTES de apretar: es el punto de todo el RF-029.
await capturar(
  op,
  'llamar',
  'Qué va a llamar el sistema',
  'El operador ve a quién va a llamar el sistema y por qué, **antes de ' +
    'apretar**. Se pulsa **«Llamar»**. La llamada es determinista y el ' +
    'orden es global entre trámites (no es un «orden por trámite» que ' +
    'jerarquice sin querer).',
  'EL SISTEMA VA A LLAMAR A',
  [[op.locator('button:has-text("Llamar")').first(), '«Llamar»']],
)
await pulsar(op, 'Llamar')
await op.waitForTimeout(3000)

// ===========================================================================
// 6. El portal del ciudadano se actualiza solo
// ===========================================================================
console.log('      esperando el sondeo del portal (10 s)…')
await espera(12000)
await abrir(ciudad, `/turno/${token}`)
await capturar(
  ciudad,
  'llamado',
  'El turno se actualiza solo en el teléfono',
  'El teléfono se repinta solo: el portal sondea su turno cada diez ' +
    'segundos (el camino rápido es un canal de difusión que solo dice ' +
    '«cambió», nunca lleva datos). Nadie tiene que recargar, y el ciudadano ' +
    'no ve nada de otros turnos.',
  'SU TURNO',
  [[ciudad.locator('h1.text-5xl').first(), 'ya llamado']],
)

// ===========================================================================
// 7. La pantalla de la sala de espera
// ===========================================================================
const tv = await escritorio.newPage()
await abrir(tv, '/pantalla')
await capturar(
  tv,
  'pantalla',
  'La pantalla de la sala de espera',
  'La pantalla muestra a quién se está llamando, y solo eso: código, ' +
    'módulo y trámite. **Sin datos personales**, porque no los hay. Va ' +
    'por una RPC pública controlada, no leyendo los turnos desde el ' +
    'navegador.',
  'ÚLTIMAS LLAMADAS',
)

// ===========================================================================
// 8. Atender y finalizar
// ===========================================================================
await abrir(op, '/admin/turnos')
await op.waitForTimeout(2500)
await capturar(
  op,
  'atencion',
  'El turno, ahora en atención',
  'El turno llamado pasa a «En atención ahora», con su módulo. Se pulsa ' +
    '**«Atender»** cuando el ciudadano llega a la ventanilla.',
  'Atender',
  [[op.locator('button:has-text("Atender")').first(), '«Atender»']],
)
if (await op.locator('button:has-text("Finalizar")').count()) {
  await op.locator('button:has-text("Finalizar")').first().click()
} else {
  await op.locator('button:has-text("Atender")').first().click()
  await op.waitForTimeout(2000)
  await op.locator('button:has-text("Finalizar")').first().click()
}
await op.waitForTimeout(2500)
await capturar(
  op,
  'finalizar',
  'Atender y finalizar',
  'Se pulsa **«Finalizar»** y el turno queda atendido. Cada transición ' +
    'queda en el historial y en la auditoría, con el operador, la hora y el ' +
    'motivo. Esa traza es inmutable: ni el propio administrador puede ' +
    'editarla.',
  'No hay turnos en curso',
)

// ===========================================================================
// 9. Un segundo ciudadano, y su oposicion
// ===========================================================================
await abrir(op, '/admin/turnos')
await op.waitForTimeout(2000)
await pulsar(op, 'Emitir turno')
await op.waitForTimeout(2500)
const token2 = (
  await op
    .locator('img[alt^="Código QR"]')
    .locator('xpath=following-sibling::p[1]')
    .innerText()
).trim()

const ciudad2 = await (await movil()).newPage()
await abrir(ciudad2, `/turno/${token2}`)
await capturar(
  ciudad2,
  'oposicion',
  'El ciudadano se opone al tratamiento',
  'Se despliega **«No quiero que se atienda mi turno»**. Toda persona ' +
    'titular puede oponerse a que traten sus datos por causa legítima. Como ' +
    'el ciudadano no deja datos de identidad, el derecho se ejerce por su ' +
    'propio token: escribe su consideración y el turno queda cancelado.',
  'No quiero que se atienda',
  [[ciudad2.locator('summary:has-text("No quiero que se atienda")'), '«No quiero que se atienda…»']],
)
await ciudad2.locator('summary:has-text("No quiero que se atienda")').click()
await ciudad2.waitForTimeout(800)
await ciudad2.fill('textarea', 'Prefiero esperar en ventanilla, no quiero el aviso.')
await ciudad2.click('button:has-text("Registrar mi consideracion")')
await ciudad2.waitForTimeout(3000)
await capturar(
  ciudad2,
  'oposicion-hecha',
  'La oposición queda registrada',
  'Se escribe la consideración y se pulsa **«Registrar mi ' +
    'consideración»**. El turno se cancela con constancia de que fue **el ' +
    'titular** y no la ventanilla: la traza lo distingue, la acción es del ' +
    'titular y no del operador.',
  'cancelado',
)
// El segundo portal y el contexto del movil ya han hecho su papel: se
// cierran para no acumular renderizadores (la memoria es el limite aqui).
await ciudad2.close()
await contextoMovil?.close().catch(() => undefined)
contextoMovil = null

// ===========================================================================
// 10. El operador lo ve
// ===========================================================================
await abrir(op, '/admin/turnos')
await op.waitForTimeout(3000)
await capturar(
  op,
  'retirados',
  'El operador ve que el ciudadano se retiró',
  'El turno ya no está en la cola: está cancelado, y el derecho a oponerse ' +
    'exige cesar. Pero **no desaparece sin más**: la tarjeta «Retirados por ' +
    'el titular» deja constancia y muestra lo que el ciudadano escribió, ' +
    'para que el operador sepa que se retiró y no que el sistema lo perdió.',
  'RETIRADOS POR EL TITULAR',
  [[op.locator('section:has-text("RETIRADOS POR EL TITULAR")'), 'aquí se ve la retirada']],
)

// ===========================================================================
// 11. Historial, estadisticas, catalogos
// ===========================================================================
for (const [ruta, slug, titulo, texto, debe] of [
  [
    '/admin/historial',
    'historial',
    'El historial',
    'Quién hizo qué, cuándo y por qué. Cada cambio de estado queda ' +
      'registrado, y la auditoría es inmutable por diseño.',
    'Historial',
  ],
  [
    '/admin/estadisticas',
    'estadisticas',
    'Las estadísticas',
    'Turnos generados, atendidos, cancelados y omitidos, y el tiempo ' +
      'promedio de atención, por trámite y por periodo.',
    'Estad',
  ],
  [
    '/admin/catalogos',
    'catalogos',
    'Los catálogos',
    'Trámites y módulos. Lo que el operador puede elegir al emitir es lo ' +
      'que está aquí, y nada más.',
    'Cat',
  ],
  [
    '/admin/usuarios',
    'usuarios',
    'Los usuarios',
    'Quién opera, con qué rol y en qué módulo. El rol decide qué puede ' +
      'hacer: un supervisor no opera turnos.',
    'Usuarios',
  ],
]) {
  await abrir(op, ruta)
  await capturar(op, slug, titulo, texto, debe)
}

// ===========================================================================
// 12. El documento
// ===========================================================================
writeFileSync(
  path.join(destino, 'pasos.json'),
  JSON.stringify(pasos, null, 2),
  'utf8',
)

// --- El Markdown ---
const md = []
md.push('# SITUR — Tutorial de uso')
md.push('')
md.push('**Recorrido real del sistema, paso a paso.** Cada imagen de este')
md.push('documento es una captura de la aplicación funcionando, con los datos')
md.push('que el sistema creó en ese momento. No hay maquetas ni dibujos.')
md.push('')
md.push('---')
md.push('')
md.push('## Antes de empezar')
md.push('')
md.push('| | |')
md.push('|---|---|')
md.push('| **Qué hace** | Un sistema de turnos para la Dirección de Catastro de Durango: el ciudadano escanea un QR, sigue su turno desde el teléfono y el operador lo llama desde la consola. |')
md.push('| **Quién entra** | El operador, con correo institucional y contraseña más un código de un segundo factor. El ciudadano, **sin cuenta**: le basta el QR. |')
md.push('| **Dónde está** | La consola en la ventanilla; el portal del ciudadano en su teléfono; la pantalla pública en la sala de espera. |')
md.push('')
md.push('---')
md.push('')
md.push('## El recorrido')
md.push('')
for (const paso of pasos) {
  md.push(`### ${paso.n}. ${paso.titulo}`)
  md.push('')
  // La imagen primero: es lo que el paso muestra, y la descripcion viene
  // despues a contarlo. En el PDF van en dos columnas, con la descripcion
  // al lado.
  md.push(`![${paso.titulo}](capturas/${paso.archivo})`)
  md.push('')
  md.push(paso.texto)
  md.push('')
}
md.push('---')
md.push('')
md.push('## Lo que este recorrido deja fuera')
md.push('')
md.push('Un tutorial que solo enseña lo que funciona se parece a un anuncio.')
md.push('Esto es lo que **no** se ha podido enseñar aquí, y por qué:')
md.push('')
md.push('- **El aviso push de verdad.** La cadena está verificada (el Service')
md.push('  Worker guarda el token y abre el portal del ciudadano), pero que')
md.push('  *llegue* el aviso necesita un VAPID real y un navegador con el')
md.push('  permiso concedido. En el arnés local no hay push service.')
md.push('- **El paso directo a Supabase.** Todo lo de aquí corre contra un')
md.push('  PostgreSQL real con PostgREST y un GoTrue propio: la misma')
md.push('  arquitectura, pero no el serviciogestionado. Lo que solo se puede')
md.push('  probar en Supabase es que `pg_cron` esté instalado y corra, que')
md.push('  `realtime.send()` difunda, y que exista la publicación')
md.push('  `supabase_realtime`.')
md.push('- **La notificación en segundo plano.** El portal del ciudadano')
md.push('  sondea su turno cada 10 segundos; el canal de difusión es el camino')
md.push('  rápido y solo dice «cambió», nunca lleva datos. En local no hay')
md.push('  servidor de Realtime, así que aquí solo se ve el sondeo.')
md.push('')
md.push('---')
md.push('')
md.push('Lo que se ve aquí está respaldado por `migracion/verificar-todo.sh` (138')
md.push('aserciones, migración, concurrencia y sincronía del DRS) y por')
md.push('`npm run alto-impacto` (accesibilidad y comportamiento, 8 pantallas, 0')
md.push('hallazgos).')
md.push('')

writeFileSync(path.join(destino, 'TUTORIAL.md'), md.join('\n'), 'utf8')

// --- El PDF (Chromium, que ya esta a mano) ---

/**
 * El texto de los pasos se escribe en markdown (`**negrita**`), porque
 * asi queda bien en el `.md`. Al pasarlo al HTML hay que convertirlo: si
 * no, el asterisco sale literal en el PDF.
 */
const aHtml = (texto) =>
  texto
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>SITUR — Tutorial de uso</title>
<style>
  @page { size: Letter; margin: 15mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
         color: #16233a; line-height: 1.55; font-size: 10pt; margin: 0; }

  /* Cada paso es un bloque que NO se parte: la descripcion y su imagen
     tienen que caer en la misma hoja, siempre. Y van DOS pasos por hoja,
     con salto de pagina forzado: asi el documento es parejo y no queda
     un hueco al final de cada pagina. */
  .paso { display: flex; gap: 6mm; align-items: flex-start;
          page-break-inside: avoid; break-inside: avoid;
          margin-bottom: 5mm; padding-bottom: 5mm;
          border-bottom: 1px solid #e3eaf3; }
  .paso.salto { page-break-after: always; break-after: page; }
  .paso .texto { flex: 0 0 52mm; width: 52mm; }
  .paso .figura { flex: 1 1 auto; min-width: 0;
                  height: 100mm; display: flex; align-items: center; justify-content: center; }
  .paso .figura img { max-width: 100%; max-height: 100mm; width: auto; height: auto;
                      border: 1px solid #d8e1ee; border-radius: 5px; }

  .num { display: inline-block; font-size: 8pt; font-weight: 700; letter-spacing: .1em;
         color: #4a6a99; text-transform: uppercase; }
  h1 { font-size: 30pt; margin: 0 0 8pt; letter-spacing: -0.02em; }
  h2 { font-size: 15pt; margin: 0 0 10pt; color: #263c59; }
  h3 { font-size: 12pt; margin: 0 0 4pt; color: #16233a; line-height: 1.25; }
  p { margin: 0 0 6pt; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; font-size: 9.5pt; }
  td { border: 1px solid #e3eaf3; padding: 5pt 7pt; vertical-align: top; }
  td:first-child { background: #f2f5f9; font-weight: 600; width: 24%; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9pt;
         background: #f2f5f9; padding: 1pt 4pt; border-radius: 3px; }
  pre { background: #f2f5f9; padding: 8pt 10pt; border-radius: 6px; overflow: hidden; }
  pre code { background: none; padding: 0; }
  ul { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin-bottom: 4pt; }
  .portada { text-align: center; padding-top: 55mm; page-break-after: always; }
  .portada p { color: #4a6a99; }
  .intro { page-break-after: always; }
  .cierre { page-break-before: always; }
</style></head><body>

<div class="portada">
  <h1>SITUR</h1>
  <p style="font-size:15pt">Tutorial de uso</p>
  <p style="font-size:11pt">Sistema de gestión y seguimiento de turnos</p>
  <p style="font-size:11pt">Dirección de Catastro · Durango</p>
  <p style="margin-top:14mm;font-size:10pt">Recorrido real del sistema, paso a paso.<br>
     Cada imagen es una captura de la aplicación funcionando.</p>
</div>

<div class="intro">
<h2>Antes de empezar</h2>
<table>
  <tr><td>Qué hace</td><td>Un sistema de turnos para la Dirección de Catastro de Durango: el ciudadano escanea un QR, sigue su turno desde el teléfono y el operador lo llama desde la consola.</td></tr>
  <tr><td>Quién entra</td><td>El operador, con correo institucional, contraseña y un código de un segundo factor. El ciudadano, <strong>sin cuenta</strong>: le basta el QR.</td></tr>
  <tr><td>Dónde está</td><td>La consola en la ventanilla; el portal del ciudadano en su teléfono; la pantalla pública en la sala de espera.</td></tr>
</table>
</div>

<h2>El recorrido</h2>
${pasos
  .map(
    (p, i) => `<div class="paso${(i + 1) % 2 === 0 ? ' salto' : ''}">
  <div class="texto">
    <p class="num">Paso ${p.n}</p>
    <h3>${p.titulo}</h3>
    <p>${aHtml(p.texto)}</p>
  </div>
  <div class="figura"><img src="capturas/${p.archivo}"></div>
</div>`,
  )
  .join('\n')}

<div class="cierre">
<h2>Lo que este recorrido deja fuera</h2>
<p>Un tutorial que solo enseña lo que funciona se parece a un anuncio. Esto es lo
que <strong>no</strong> se ha podido enseñar aquí, y por qué:</p>
<ul>
  <li><strong>El aviso push de verdad.</strong> La cadena está verificada (el Service Worker
  guarda el token y abre el portal del ciudadano), pero que <em>llegue</em> el aviso necesita un
  VAPID real y un navegador con el permiso concedido. En el arnés local no hay push service.</li>
  <li><strong>El paso directo a Supabase.</strong> Todo lo de aquí corre contra un PostgreSQL real con
  PostgREST y un GoTrue propio: la misma arquitectura, pero no el servicio gestionado. Lo que solo se
  puede probar en Supabase es que <code>pg_cron</code> esté instalado y corra, que <code>realtime.send()</code>
  difunda, y que exista la publicación <code>supabase_realtime</code>.</li>
  <li><strong>La notificación en segundo plano.</strong> El portal del ciudadano sondea su turno cada 10
  segundos; el canal de difusión es el camino rápido y solo dice «cambió», nunca lleva datos. En local no hay
  servidor de Realtime, así que aquí solo se ve el sondeo.</li>
</ul>

<p style="margin-top:10pt;font-size:9.5pt;color:#4a6a99">
Lo que se ve aquí está respaldado por <code>migracion/verificar-todo.sh</code> (138 aserciones, migración,
concurrencia y sincronía del DRS) y por <code>npm run alto-impacto</code> (accesibilidad y comportamiento,
8 pantallas, 0 hallazgos).
</p>
</div>
</body></html>`

const htmlFile = path.join(destino, 'TUTORIAL.html')
writeFileSync(htmlFile, html, 'utf8')

const pagina = await navegador.newPage()
await pagina.goto('file://' + htmlFile, { waitUntil: 'networkidle' })
// Las capturas pesan varios megas: sin esperar a que esten DECODIFICADAS,
// Chromium imprime alguna en blanco (el marco sale, el contenido no).
await pagina.evaluate(async () => {
  await Promise.all(
    [...document.images].map((img) =>
      img.complete
        ? img.decode().catch(() => undefined)
        : new Promise((r) => {
            img.onload = () => img.decode().catch(() => undefined).then(r)
            img.onerror = () => r()
          }),
    ),
  )
})
await pagina.waitForTimeout(600)
await pagina.pdf({
  path: path.join(destino, 'TUTORIAL.pdf'),
  format: 'Letter',
  printBackground: true,
  margin: { top: '15mm', bottom: '15mm', left: '14mm', right: '14mm' },
})
await pagina.close()

console.log(`\n  ${pasos.length} capturas en ${capturas}`)
console.log(`  tutorial en ${path.join(destino, 'TUTORIAL.md')}`)
console.log(`  PDF en ${path.join(destino, 'TUTORIAL.pdf')}`)

await contextoMovil?.close().catch(() => undefined)
await navegador.close()
