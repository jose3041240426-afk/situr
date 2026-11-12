/**
 * SITUR — Usuario de prueba con MFA verificado.
 *
 * Crea una cuenta en Supabase Auth, le verifica un factor TOTP y la da de
 * alta en `usuarios` como agente. Sirve para probar de punta a punta la
 * pantalla de perfil (y cualquier otra cosa que pida el segundo factor)
 * sin usar la cuenta real de nadie.
 *
 * Uso:  node scripts/usuario-de-prueba.mjs [correo]
 * Al final imprime el secreto TOTP, que es lo que permite calcular el
 * código de seis dígitos.
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const secrets = {}
for (const linea of readFileSync(new URL('../secretos.env', import.meta.url), 'utf8').split('\n')) {
  const m = linea.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) secrets[m[1]] = m[2].trim()
}

const URL_ = secrets.SUPABASE_URL
const ANON = secrets.SUPABASE_ANON_KEY
const SR = secrets.SUPABASE_SERVICE_ROLE_KEY

const correo = process.argv[2] ?? 'prueba-perfil@situr.test'
const clave = 'ClavePerfil123'

async function auth(ruta, cuerpo, { apikey = SR, token = SR } = {}) {
  const r = await fetch(`${URL_}/auth/v1${ruta}`, {
    method: 'POST',
    headers: {
      apikey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  })
  const t = await r.text()
  let j = null
  try {
    j = JSON.parse(t)
  } catch {
    /* la respuesta no era JSON */
  }
  return { status: r.status, j, t }
}

/** El código TOTP de seis dígitos (RFC 6238) a partir del secreto. */
function totp(secreto) {
  const k = Buffer.from(secreto, 'base64')
  const c = Math.floor(Date.now() / 1000 / 30)
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(c))
  const h = createHmac('sha1', k).update(b).digest()
  const o = h[h.length - 1] & 0x0f
  const n =
    ((h[o] & 0x7f) << 24) |
    ((h[o + 1] & 0xff) << 16) |
    ((h[o + 2] & 0xff) << 8) |
    (h[o + 3] & 0xff)
  return String(n % 10 ** 6).padStart(6, '0')
}

// 1) La cuenta en Supabase Auth
let uid = null
let sesion = await auth('/token?grant_type=password', { email: correo, password: clave }, { apikey: ANON, token: ANON })
if (sesion.status === 200) {
  uid = sesion.j.user.id
  console.log('· la cuenta ya existía')
} else {
  const creado = await auth('/admin/users', { email: correo, password: clave, email_confirm: true })
  uid = creado.j?.id
  console.log('· cuenta creada:', creado.status)
  sesion = await auth('/token?grant_type=password', { email: correo, password: clave }, { apikey: ANON, token: ANON })
}
if (!uid) {
  console.error('No se pudo crear la cuenta:', sesion.t.slice(0, 300))
  process.exit(1)
}
const at = sesion.j.access_token

// 2) El factor TOTP, verificado
const enroll = await auth('/factors', { factor_type: 'totp', friendly_name: 'prueba' }, { apikey: ANON, token: at })
let factorId = enroll.j?.id
let secreto = enroll.j?.totp?.secret
if (!factorId) {
  // Ya había un factor: se listan y se toma el verificado
  const r = await fetch(`${URL_}/auth/v1/user/factors`, {
    headers: { apikey: ANON, Authorization: `Bearer ${at}` },
  })
  const texto = await r.text()
  let lista = null
  try {
    lista = JSON.parse(texto)
  } catch {
    lista = null
  }
  const v = lista?.totp?.find((f) => f.status === 'verified')
  factorId = v?.id
  console.log('· factors (listado):', r.status, v ? 'había uno verificado' : texto.slice(0, 160))
}
if (factorId && secreto) {
  const ver = await auth(`/factors/${factorId}/verify`, { code: totp(secreto) }, { apikey: ANON, token: at })
  console.log('· factor verificado:', ver.status === 200 ? 'sí' : ver.t.slice(0, 200))
}

// 3) La fila en `usuarios` (rol AGENTE, módulo M01)
const { execFileSync } = await import('node:child_process')
// `pathname` devuelve la ruta percenteada (la carpeta «Música» lleva una ñ),
// y bash no encuentra el archivo. `fileURLToPath` la deja como es.
const psql = fileURLToPath(new URL('./psql-supabase.sh', import.meta.url))
const sql = `
INSERT INTO public.usuarios (auth_uid, nombres, apellido_paterno_id, email, numero_empleado, rol_id, modulo_id, activo, mfa_habilitado)
VALUES ('${uid}', 'Prueba', (SELECT id FROM public.apellidos LIMIT 1), '${correo}', 'EMP-PRUEBA',
        (SELECT id FROM public.roles WHERE clave = 'AGENTE'),
        (SELECT id FROM public.modulos WHERE codigo = 'M01'),
        true, true)
ON CONFLICT (email) DO UPDATE SET auth_uid = EXCLUDED.auth_uid, mfa_habilitado = true, activo = true;
`
try {
  execFileSync('bash', [psql, '-tA', '-c', sql], { stdio: 'inherit' })
  console.log('· alta en `usuarios`: hecha')
} catch (e) {
  console.error('· alta en `usuarios`: FALLÓ')
}

console.log('\nCORREO=' + correo)
console.log('CLAVE=' + clave)
console.log('SECRETO_TOTP=' + (secreto ?? '(ya existía; bórralo para rehacerlo)'))
console.log('UID=' + uid)
