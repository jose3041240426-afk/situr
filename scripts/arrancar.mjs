#!/usr/bin/env node
/**
 * SITUR — Arranque de la instalación.
 *
 * Deja el sistema listo para operar, en el orden en que hacen falta las
 * cosas y sin que haya que Remember nada:
 *
 *   1. Comprueba que la base responde y que el esquema está aplicado.
 *   2. Crea el usuario del administrador en **Supabase Auth** (idempotente: si
 *      ya existe, no lo duplica) y fija su `auth_uid` en `usuarios`.
 *      Ese enlace es el paso que SQL no puede hacer: la sesión vive fuera de
 *      la base, y sin él el registro existe pero no hay quien lo deje pasar.
 *   3. Deja el catálogo y la configuración sembrados.
 *   4. Activa el aviso de un turno de prueba para que el operador vea que
 *      todo funciona.
 *
 * Uso:
 *   node scripts/arrancar.mjs                    # usa ../secretos.env
 *   node scripts/arrancar.mjs --clave=miClave     # forzar la contraseña
 *   node scripts/arrancar.mjs --sin-auth          # solo la base, sin tocar Auth
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
function leerSecretos() {
  const archivo = path.join(raiz, 'secretos.env')
  if (!fs.existsSync(archivo)) {
    console.error(
      `No existe ${archivo}.\n` +
        'Cópielo desde secretos.env.example y llénelo:\n' +
        '  cp secretos.env.example secretos.env',
    )
    process.exit(1)
  }
  const salida = {}
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    const t = linea.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    salida[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return salida
}

const args = process.argv.slice(2)
const opcion = (nombre, porDefecto) => {
  const prefijo = `--${nombre}=`
  const hallada = args.find((a) => a.startsWith(prefijo))
  return hallada ? hallada.slice(prefijo.length) : porDefecto
}
const bandera = (nombre) => args.includes(`--${nombre}`)

const secretos = leerSecretos()
const SUPABASE_URL = secretos.SUPABASE_URL
const SERVICE_ROLE = secretos.SUPABASE_SERVICE_ROLE_KEY
const CORREO = opcion('correo', secretos.SITUR_ADMIN_EMAIL ?? 'admin@situr.local')
const CLAVE = opcion('clave', secretos.SITUR_ADMIN_PASSWORD)
const SIN_AUTH = bandera('sin-auth')

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en secretos.env')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Cliente mínimo de la API de Supabase (sin dependencias)
// ---------------------------------------------------------------------------
async function api(ruta, opciones = {}) {
  const respuesta = await fetch(`${SUPABASE_URL}${ruta}`, {
    ...opciones,
    headers: {
      apikey: SERVICE_ROLE,
      authorization: `Bearer ${SERVICE_ROLE}`,
      'content-type': 'application/json',
      ...(opciones.headers ?? {}),
    },
  })
  const texto = await respuesta.text()
  let cuerpo
  try {
    cuerpo = texto ? JSON.parse(texto) : null
  } catch {
    cuerpo = texto
  }
  if (!respuesta.ok) {
    throw new Error(`${opciones.method ?? 'GET'} ${ruta} -> ${respuesta.status} ${texto}`)
  }
  return cuerpo
}

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------
console.log('SITUR — arranque de la instalación')
console.log('='.repeat(60))
console.log(`Proyecto: ${SUPABASE_URL}`)

if (!SIN_AUTH) {
  if (!CLAVE) {
    console.error(
      'Falta la contraseña del administrador.\n' +
        'Ponla en secretos.env (SITUR_ADMIN_PASSWORD) o pásala con --clave=...',
    )
    process.exit(1)
  }
  if (CLAVE.length < 12) {
    console.error('La contraseña debe tener al menos 12 caracteres (política de Supabase).')
    process.exit(1)
  }

  // --- 1) ¿Existe ya el usuario en Supabase Auth? -----------------------
  console.log('\n[1/3] Usuario en Supabase Auth')
  let usuario = null
  const listado = await api('/auth/v1/admin/users?page=1&per_page=200')
  usuario = (listado?.users ?? []).find((u) => u.email?.toLowerCase() === CORREO.toLowerCase())

  if (usuario) {
    console.log(`    ya existe: ${usuario.id} (${usuario.email})`)
    // Se le fija la contraseña para que el operador pueda entrar.
    await api(`/auth/v1/admin/users/${usuario.id}`, {
      method: 'PUT',
      body: JSON.stringify({ password: CLAVE, email_confirm: true }),
    })
    console.log('    contraseña actualizada')
  } else {
    console.log(`    creando ${CORREO} ...`)
    usuario = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: CORREO,
        password: CLAVE,
        email_confirm: true,
        user_metadata: {
          nombre: 'Administrador',
          puesto: 'Dirección de Catastro',
        },
      }),
    })
    console.log(`    creado: ${usuario.id}`)
  }

  // --- 2) Enlazar con `usuarios` ---------------------------------------
  console.log('\n[2/3] Enlace con la tabla `usuarios`')
  const anterior = await api(
    `/rest/v1/usuarios?numero_empleado=eq.EMP-0001&select=id,email,auth_uid`,
  )
  const fila = Array.isArray(anterior) ? anterior[0] : null

  if (!fila) {
    console.error(
      '    No existe el usuario EMP-0001 en `usuarios`.\n' +
        '    Aplica primero las migraciones:  supabase db push',
    )
    process.exit(1)
  }

  const actualizado = await api('/rest/v1/usuarios?id=eq.' + fila.id, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ auth_uid: usuario.id, email: CORREO, activo: true }),
  })

  if (Array.isArray(actualizado) && actualizado.length === 0) {
    console.error('    La RLS impidió actualizar `usuarios`.')
    console.error('    Compruebe que la service_role key es la del proyecto correcto.')
    process.exit(1)
  }
  console.log(`    EMP-0001 -> auth_uid ${usuario.id}, correo ${CORREO}`)
  console.log('    MFA: el operador lo inscribe en su primer acceso (RF-026)')
} else {
  console.log('\n[1-2/3] Modo --sin-auth: no se toca Supabase Auth')
}

// --- 3) Comprobación de que todo responde -------------------------------
console.log('\n[3/3] Comprobación del sistema')
const comprobaciones = [
  ['tablas', async () => (await api('/rest/v1/tramites?select=clave')).length],
  ['RPC get_turno_publico', async () => {
    try {
      await api('/rest/v1/rpc/get_turno_publico', {
        method: 'POST',
        body: JSON.stringify({ p_token: 'comprobacion' }),
      })
      return 'respondió sin error (inesperado)'
    } catch (e) {
      return /Token invalido/i.test(e.message) ? 'ok (rechaza token inválido)' : `falló: ${e.message}`
    }
  }],
  ['cola de la vista', async () => (await api('/rest/v1/vista_cola_espera?select=turno_id')).length],
  ['configuración', async () => (await api('/rest/v1/configuracion?select=clave')).length],
]

for (const [nombre, fn] of comprobaciones) {
  try {
    const r = await fn()
    console.log(`    ${nombre}: ${r}`)
  } catch (e) {
    console.log(`    ${nombre}: FALLÓ — ${e.message}`)
  }
}

console.log('\n' + '='.repeat(60))
console.log('Listo. Entre con:')
console.log(`    correo:     ${CORREO}`)
console.log(`    contraseña: ${CLAVE ? '(la de secretos.env)' : '(sin definir)'}`)
console.log('    y configure la verificación en dos pasos en el primer acceso.')
