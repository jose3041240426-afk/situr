import { chromium } from 'playwright-core'

const TOKEN = process.argv[2]
const navegador = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] })
const contexto = await navegador.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  isMobile: true,
  hasTouch: true,
})
await contexto.grantPermissions(['notifications'], { origin: 'https://situr.vercel.app' })
const pagina = await contexto.newPage()
const consola = []
pagina.on('console', (m) => consola.push(`[${m.type()}] ${m.text()}`))
pagina.on('pageerror', (e) => consola.push(`[pageerror] ${e.message}`))
const red = []
pagina.on('response', async (r) => {
  if (r.url().includes('/api/suscripcion')) red.push(`${r.status()} ${r.request().method()} ${r.url()}`)
})

await pagina.goto(`https://situr.vercel.app/turno/${TOKEN}`, { waitUntil: 'networkidle' })
await pagina.waitForTimeout(3000)

console.log('permiso inicial:', await pagina.evaluate(() => ('Notification' in window ? Notification.permission : 'sin Notification')))
console.log('¿modal de aviso?', await pagina.getByText('¿Le avisamos', { exact: false }).count())

const btn = pagina.getByRole('button', { name: /Sí, avísame/i })
console.log('¿botón "Sí, avísame"?', await btn.count())
if (await btn.count()) {
  await btn.first().click()
  await pagina.waitForTimeout(3000)
  console.log('permiso tras pulsar:', await pagina.evaluate(() => Notification.permission))
  console.log('texto en pantalla:', (await pagina.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n/g, ' | '))
}
console.log('llamadas a /api/suscripcion:', red.length ? red.join(' · ') : 'ninguna')
console.log('--- consola del navegador ---')
console.log(consola.slice(0, 12).join('\n') || '(sin mensajes)')
await pagina.screenshot({ path: '/tmp/opencode/probe-push.png', fullPage: false })
await navegador.close()
