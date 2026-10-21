#!/usr/bin/env node
/**
 * SITUR — Genera el PDF del tutorial a partir de las capturas.
 *
 *   node pruebas/tutorial-pdf.mjs [--carpeta=...]
 *
 * Va aparte del recorrido (`tutorial.mjs`) a propósito: las capturas y el
 * PDF son dos trabajos distintos, y el PDF es el que se queda sin memoria
 * (tiene que descargar y embeber 21 imágenes). Separados, un fallo en uno
 * no tira el otro: se repita solo el que ha fallado.
 *
 * Para el PDF se hace una copia reducida de cada captura (1000 px de ancho,
 * JPEG): a resolución completa son varios megas y el generador de PDF se
 * queda sin memoria y sale a medias.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')
const proyecto = path.resolve(raiz, '..')

const arg = (n, d) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d

const destino = path.resolve(arg('carpeta', path.join(proyecto, 'tutorial')))
const capturas = path.join(destino, 'capturas')
const manifiesto = path.join(destino, 'pasos.json')

if (!existsSync(manifiesto)) {
  console.error(
    `No está ${manifiesto}. Primero hay que hacer el recorrido: node pruebas/tutorial.mjs`,
  )
  process.exit(2)
}
const pasos = JSON.parse(readFileSync(manifiesto, 'utf8'))

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

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 1) el navegador ---
const navegador = await chromium.launch({
  executablePath: chrome,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
  ],
})

/**
 * El texto de los pasos va en markdown (`**negrita**`), porque así queda bien
 * en el `.md`. Al pasarlo al HTML hay que convertirlo: si no, el asterisco
 * sale literal en el PDF.
 */
const aHtml = (texto) =>
  texto
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

// --- 2) el HTML ---
const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>SITUR — Tutorial de uso</title>
<style>
  @page { size: Letter; margin: 15mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
         color: #16233a; line-height: 1.55; font-size: 10pt; margin: 0; }
  .paso { display: flex; gap: 7mm; align-items: flex-start;
          page-break-inside: avoid; break-inside: avoid;
          margin-bottom: 9mm; padding-bottom: 9mm;
          border-bottom: 1px solid #e3eaf1; }
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
  td { border: 1px solid #e3eaf1; padding: 5pt 7pt; vertical-align: top; }
  td:first-child { background: #f2f5f9; font-weight: 600; width: 24%; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9pt;
         background: #f2f5f9; padding: 1pt 4pt; border-radius: 3px; }
  pre { background: #f2f5f9; padding: 8pt 10pt; border-radius: 6px; overflow: hidden; }
  pre code { background: none; padding: 0; }
  ul { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin-bottom: 4pt; }
  .portada { text-align: center; padding-top: 55mm; page-break-after: always; }
  .portada p { color: #4a6a99; }
</style></head><body>

<div class="portada">
  <h1>SITUR</h1>
  <p style="font-size:15pt">Tutorial de uso</p>
  <p style="font-size:11pt">Sistema de gestión y seguimiento de turnos</p>
  <p style="font-size:11pt">Dirección de Catastro · Durango</p>
  <p style="margin-top:14mm;font-size:10pt">Recorrido real del sistema, paso a paso.<br>
     Cada imagen es una captura de la aplicación funcionando.</p>
</div>

<h2>Antes de empezar</h2>
<table>
  <tr><td>Qué hace</td><td>Un sistema de turnos para la Dirección de Catastro de Durango: el ciudadano escanea un QR, sigue su turno desde el teléfono y el operador lo llama desde la consola.</td></tr>
  <tr><td>Quién entra</td><td>El operador, con correo institucional, contraseña y un código de un segundo factor. El ciudadano, <strong>sin cuenta</strong>: le basta el QR.</td></tr>
  <tr><td>Dónde está</td><td>La consola en la ventanilla; el portal del ciudadano en su teléfono; la pantalla pública en la sala de espera.</td></tr>
</table>

<h2>El recorrido</h2>
${pasos
  .map(
    (p) => `<div class="paso">
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

</div>
</body></html>`

const htmlFile = path.join(destino, 'TUTORIAL.html')
writeFileSync(htmlFile, html, 'utf8')

// --- 3) el PDF ---
const pagina = await navegador.newPage()
await pagina.goto('file://' + htmlFile, { waitUntil: 'networkidle' })
// Las imagenes tienen que estar DECODIFICADAS: si no, Chromium imprime
// alguna en blanco (el marco sale, el contenido no).
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
await espera(800)
await pagina.pdf({
  path: path.join(destino, 'TUTORIAL.pdf'),
  format: 'Letter',
  printBackground: true,
  margin: { top: '15mm', bottom: '15mm', left: '14mm', right: '14mm' },
})
await pagina.close()
await navegador.close()

console.log(`  PDF: ${path.join(destino, 'TUTORIAL.pdf')}`)
