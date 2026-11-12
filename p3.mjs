import { chromium } from 'playwright-core'
import { createHmac } from 'node:crypto'
const SECRETO = process.env.SECRETO_TOTP
function totp(s) {
  const k = Buffer.from(s, 'base64')
  const c = Math.floor(Date.now() / 1000 / 30)
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(c))
  const h = createHmac('sha1', k).update(b).digest()
  const o = h[h.length - 1] & 0x0f
  const n = ((h[o] & 0x7f) << 24) | ((h[o+1] & 0xff) << 16) | ((h[o+2] & 0xff) << 8) | (h[o+3] & 0xff)
  return String(n % 10 ** 6).padStart(6, '0')
}
const nav = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox','--disable-gpu'] })
const p = await nav.newPage({ viewport: { width: 440, height: 900 } })
p.on('response', async (r) => {
  if (r.url().includes('/auth/v1/factors') && r.url().includes('verify')) {
    console.log('   [verify]', r.status(), (await r.text().catch(()=> '')).slice(0, 300))
  }
})
await p.goto('https://situr.vercel.app/admin', { waitUntil: 'networkidle' })
await p.waitForTimeout(2000)
await p.locator('input#correo').fill('prueba-mfa@situr.test')
await p.locator('input#clave').fill('ClaveDePrueba123')
await p.getByRole('button', { name: 'Entrar' }).click()
await p.waitForTimeout(5000)
const codigo = totp(SECRETO)
console.log('   código:', codigo, '· reloj local:', new Date().toISOString())
const c = p.locator('input[inputmode="numeric"]')
for (let i = 0; i < 6; i++) { await c.nth(i).fill(codigo[i]); await p.waitForTimeout(80) }
await p.waitForTimeout(5000)
await nav.close()
