#!/usr/bin/env node
/**
 * SITUR — Arnés local de pruebas.
 *
 * Levanta un Supabase mínimo sobre el PostgreSQL local para poder probar la
 * aplicación de verdad, con la base real y la RLS real:
 *
 *   :9999  GoTrue mínimo  (login, /user, logout) con JWT HS256
 *   :3000  PostgREST       (la API de datos: RPC, vistas, RLS)
 *   :54321 proxy           (/rest/v1 -> 3000, /auth/v1 -> 9999)
 *
 * NO es parte de la aplicación. En producción, Supabase aporta estas tres
 * piezas ya montadas; aquí solo se replican para poder verificar el
 * behaviour del cliente sin conexión a internet.
 *
 * Uso:  node arnes-local.mjs <url-base-de-datos> <puerto-proxy>
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SECRETO = 'situr-pruebas-jwt-secreto-largo-suficiente-1234567890'
const PUERTO_AUTHT = 9999
const PUERTO_PGRST = 3000
const PUERTO_PROXY = Number(process.argv[3] ?? 54321)
const URL_BD = process.argv[2] ?? 'postgresql://postgres@127.0.0.1:5432/situr_app'

// ---------------------------------------------------------------------------
// JWT HS256 a mano (sin dependencias)
// ---------------------------------------------------------------------------
function b64url(datos) {
  return Buffer.from(datos).toString('base64url')
}

function firmarJWT(payload, { exp = 3600 } = {}) {
  const ahora = Math.floor(Date.now() / 1000)
  const cab = { alg: 'HS256', typ: 'JWT' }
  const cuerpo = { ...payload, iat: ahora, exp: ahora + exp, iss: 'situr-local' }
  const datos = `${b64url(JSON.stringify(cab))}.${b64url(JSON.stringify(cuerpo))}`
  const firma = crypto.createHmac('sha256', SECRETO).update(datos).digest('base64url')
  return `${datos}.${firma}`
}

function verificarJWT(token) {
  try {
    const [cab, cuerpo, firma] = token.split('.')
    const esperado = crypto
      .createHmac('sha256', SECRETO)
      .update(`${cab}.${cuerpo}`)
      .digest('base64url')
    if (esperado !== firma) return null
    const payload = JSON.parse(Buffer.from(cuerpo, 'base64url').toString())
    if (payload.exp && payload.exp < Date.now() / 1000) return null
    return payload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// GoTrue mínimo
// ---------------------------------------------------------------------------
const USUARIOS = {
  'admin@situr.local': {
    uuid: '11111111-1111-1111-1111-111111111111',
    password: 'situr-admin-2026',
    email: 'admin@situr.local',
  },
  'agente@situr.local': {
    uuid: '22222222-2222-2222-2222-222222222222',
    password: 'situr-agente-2026',
    email: 'agente@situr.local',
  },
}

/** Factores MFA en memoria, por usuario. El código aceptado es 123456. */
const FACTORES = new Map()
const CODIGO_MFA = '123456'

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let datos = ''
    req.on('data', (c) => (datos += c))
    req.on('end', () => {
      try {
        resolve(datos ? JSON.parse(datos) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function responder(res, codigo, objeto) {
  const texto = JSON.stringify(objeto)
  res.writeHead(codigo, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  })
  res.end(texto)
}

const authServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PUERTO_AUTHT}`)
  const ruta = url.pathname.replace('/auth/v1', '')

  if (req.method === 'OPTIONS') return responder(res, 204, {})

  if (ruta === '/token' && req.method === 'POST') {
    const cuerpo = await leerCuerpo(req)
    const usuario = USUARIOS[String(cuerpo.email ?? '').toLowerCase()]
    if (!usuario || usuario.password !== cuerpo.password) {
      return responder(res, 400, {
        error: 'invalid_grant',
        error_description: 'Invalid login credentials',
      })
    }
    const token = firmarJWT({
      sub: usuario.uuid,
      email: usuario.email,
      role: 'authenticated',
      aud: 'authenticated',
    })
    return responder(res, 200, {
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: firmarJWT({ sub: usuario.uuid, role: 'authenticated', type: 'refresh' }),
      user: {
        id: usuario.uuid,
        aud: 'authenticated',
        role: 'authenticated',
        email: usuario.email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      },
    })
  }

  if (ruta === '/user' && req.method === 'GET') {
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '')
    const payload = verificarJWT(auth)
    if (!payload) return responder(res, 401, { message: 'invalid token' })
    return responder(res, 200, {
      id: payload.sub,
      aud: 'authenticated',
      role: 'authenticated',
      email: payload.email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    })
  }

  if (ruta === '/logout' && req.method === 'POST') {
    return responder(res, 204, {})
  }

  // ------------------------------------------------------------------ MFA
  const usuarioDe = (req) => {
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '')
    return verificarJWT(auth)
  }

  if (ruta === '/factors' && req.method === 'POST') {
    const payload = usuarioDe(req)
    if (!payload) return responder(res, 401, { message: 'invalid token' })
    const cuerpo = await leerCuerpo(req)
    const id = crypto.randomUUID()
    const secreto = crypto.randomBytes(10).toString('base64url')
    FACTORES.set(payload.sub, { id, secret: secreto, friendly: cuerpo.friendly_name ?? 'MFA' })
    return responder(res, 200, {
      id,
      type: cuerpo.factor_type ?? 'totp',
      friendly_name: cuerpo.friendly_name ?? 'MFA',
      status: 'unverified',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      totp: {
        qr_code: `data:image/svg+xml;base64,${Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><text x="100" y="105" font-size="12" text-anchor="middle" fill="#000">otpauth://totp/SITUR:${payload.email}?secret=${secreto}</text></svg>`,
        ).toString('base64')}`,
        secret: secreto,
        uri: `otpauth://totp/SITUR:${payload.email}?secret=${secreto}`,
      },
    })
  }

  if (ruta === '/factors' && req.method === 'GET') {
    const payload = usuarioDe(req)
    if (!payload) return responder(res, 401, { message: 'invalid token' })
    const f = FACTORES.get(payload.sub)
    return responder(res, 200, {
      all: f
        ? [
            {
              id: f.id,
              type: 'totp',
              friendly_name: f.friendly,
              status: 'verified',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ]
        : [],
    })
  }

  if (/^\/factors\/[^/]+\/challenge$/.test(ruta) && req.method === 'POST') {
    const payload = usuarioDe(req)
    if (!payload) return responder(res, 401, { message: 'invalid token' })
    return responder(res, 200, {
      id: ruta.split('/')[2],
      expires_at: Math.floor(Date.now() / 1000) + 300,
    })
  }

  if (/^\/factors\/[^/]+\/verify$/.test(ruta) && req.method === 'POST') {
    const payload = usuarioDe(req)
    if (!payload) return responder(res, 401, { message: 'invalid token' })
    const cuerpo = await leerCuerpo(req)
    if (String(cuerpo.code) !== CODIGO_MFA) {
      return responder(res, 400, {
        error: 'otp_expired',
        error_description: 'Invalid TOTP code',
      })
    }
    // Como en Supabase, el token devuelto ya viene con el assurance aal2.
    // OJO: `setSession()` de supabase-js exige access_token **y**
    // refresh_token; si falta el segundo, descarta la sesión entera.
    const token = firmarJWT({
      sub: payload.sub,
      email: payload.email,
      role: 'authenticated',
      aud: 'authenticated',
      amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      aal: 'aal2',
    })
    const refresh = firmarJWT({
      sub: payload.sub,
      role: 'authenticated',
      type: 'refresh',
    })
    // Y la base se queda con la marca de MFA habilitada (RF-026).
    // OJO: el cliente de Supabase necesita una URL HTTP, no la de PostgreSQL:
    // se usa el propio proxy del arnés.
    try {
      const admin = createClient(`http://127.0.0.1:${PUERTO_PROXY}`, firmarJWT({ role: 'service_role' }), {
        auth: { persistSession: false },
      })
      const { error: errDb } = await admin
        .from('usuarios')
        .update({ mfa_habilitado: true })
        .eq('auth_uid', payload.sub)
      if (errDb) console.log(`[arnés] no se pudo marcar el MFA: ${errDb.message}`)
    } catch (e) {
      console.log(`[arnés] no se pudo marcar el MFA en la base: ${e.message}`)
    }
    return responder(res, 200, {
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refresh,
      user: { id: payload.sub, email: payload.email, role: 'authenticated' },
    })
  }

  if (ruta === '/authenticator-assurance-level' && req.method === 'GET') {
    const payload = usuarioDe(req)
    if (!payload) return responder(res, 401, { message: 'invalid token' })
    return responder(res, 200, {
      current_level: payload.aal ?? 'aal1',
      next_level: 'aal2',
      current_authentication_methods: [{ method: 'password' }],
    })
  }

  // ----------------------------------------------- API de administración
  // La usa `scripts/arrancar.mjs` para crear el administrador y enlazarlo
  // con `usuarios.auth_uid`. Es la misma superficie que expone Supabase.
  const esAdmin = (req) => {
    const token = (req.headers.authorization ?? '').replace('Bearer ', '')
    const payload = verificarJWT(token)
    return payload?.role === 'service_role'
  }

  if (ruta === '/admin/users' && req.method === 'GET') {
    if (!esAdmin(req)) return responder(res, 401, { message: 'necesita service_role' })
    const lista = Object.values(USUARIOS).map((u) => ({
      id: u.uuid,
      aud: 'authenticated',
      role: 'authenticated',
      email: u.email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    }))
    return responder(res, 200, { users: lista, aud: '' })
  }

  if (ruta === '/admin/users' && req.method === 'POST') {
    if (!esAdmin(req)) return responder(res, 401, { message: 'necesita service_role' })
    const cuerpo = await leerCuerpo(req)
    const email = String(cuerpo.email ?? '').toLowerCase()
    if (!email) return responder(res, 400, { message: 'falta el correo' })
    if (USUARIOS[email]) {
      return responder(res, 422, { message: 'el usuario ya existe', email })
    }
    const nuevo = {
      uuid: crypto.randomUUID(),
      password: cuerpo.password ?? crypto.randomBytes(12).toString('base64url'),
      email,
    }
    USUARIOS[email] = nuevo
    return responder(res, 200, {
      id: nuevo.uuid,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: cuerpo.user_metadata ?? {},
      created_at: new Date().toISOString(),
    })
  }

  if (/^\/admin\/users\/[^/]+$/.test(ruta) && req.method === 'PUT') {
    if (!esAdmin(req)) return responder(res, 401, { message: 'necesita service_role' })
    const id = ruta.split('/')[3]
    const cuerpo = await leerCuerpo(req)
    const encontrado = Object.values(USUARIOS).find((u) => u.uuid === id)
    if (!encontrado) return responder(res, 404, { message: 'no existe' })
    if (cuerpo.password) encontrado.password = cuerpo.password
    if (cuerpo.email) encontrado.email = String(cuerpo.email).toLowerCase()
    return responder(res, 200, {
      id: encontrado.uuid,
      aud: 'authenticated',
      role: 'authenticated',
      email: encontrado.email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    })
  }

  return responder(res, 404, { message: 'ruta no implementada en el arnés local' })
})

// ---------------------------------------------------------------------------
// Proxy: /rest/v1 -> PostgREST, /auth/v1 -> GoTrue
// ---------------------------------------------------------------------------
const proxy = http.createServer((req, res) => {
  const destinoAuth = req.url.startsWith('/auth/v1')
  const destino = destinoAuth ? PUERTO_AUTHT : PUERTO_PGRST
  const ruta = destinoAuth
    ? req.url.replace('/auth/v1', '')
    : req.url.replace('/rest/v1', '')

  const opciones = {
    hostname: '127.0.0.1',
    port: destino,
    path: ruta || '/',
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${destino}` },
  }

  const peticion = http.request(opciones, (r) => {
    res.writeHead(r.statusCode ?? 200, {
      ...r.headers,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    })
    r.pipe(res)
  })
  peticion.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'el arnés local no respondió' }))
  })
  req.pipe(peticion)
})

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function alEscuchar(puerto, nombre) {
  return () => console.log(`[arnés] ${nombre.padEnd(6)} -> :${puerto}`)
}

/**
 * Si el puerto está ocupado, decirlo claro. Si no, el arnés muere en silencio
 * y el que sigue en su sitio es el de **otra** base, que es peor que no
 * tener ninguno: la aplicación parecería funcionar contra la base
 * equivocada.
 */
function vigilarPuerto(servidor, puerto, nombre) {
  servidor.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(
        `\n[arnés] EL PUERTO ${puerto} YA ESTÁ OCUPADO.\n` +
          `  Hay otro arnés o PostgREST en marcha. Si es de otra base, la\n` +
          `  aplicación estaría hablando con ella sin avisar.\n` +
          `  Pare el que esté en marcha (o use pruebas/levantar.sh, que lo\n` +
          `  hace por usted) y vuelva a intentarlo.\n`,
      )
    } else {
      console.error(`[arnés] ${nombre} no pudo arrancar: ${e.message}`)
    }
    process.exit(1)
  })
}

vigilarPuerto(authServer, PUERTO_AUTHT, 'auth')
vigilarPuerto(proxy, PUERTO_PROXY, 'proxy')

authServer.listen(PUERTO_AUTHT, alEscuchar(PUERTO_AUTHT, 'auth'))
proxy.listen(PUERTO_PROXY, alEscuchar(PUERTO_PROXY, 'proxy'))

// La clave anon que usará la app: un JWT con rol `anon`.
const ANON_KEY = firmarJWT({ role: 'anon' }, { exp: 86400 * 365 })
// Y la de `service_role`, para el emisor de push. Se imprime para que
// `levantar.sh` la escriba en `.env.local` y las funciones de `api/`
// hablen con ESTE arnés y no con el proyecto de Supabase de `secretos.env`.
const SERVICE_ROLE_KEY = firmarJWT({ role: 'service_role' }, { exp: 86400 * 365 })
console.log(`[arnés] ANON_KEY=${ANON_KEY}`)
console.log(`[arnés] SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`)
console.log(`[arnés] URL para la app: http://127.0.0.1:${PUERTO_PROXY}`)
console.log(`[arnés] base de datos: ${URL_BD}`)

// Verifica que la base responde y muestra qué hay.
try {
  const cliente = createClient(`http://127.0.0.1:${PUERTO_PROXY}`, ANON_KEY, {
    auth: { persistSession: false },
  })
  const { error } = await cliente.rpc('get_turno_publico', { p_token: 'inexistente' })
  console.log(`[arnés] la base responde (error esperado: ${error?.code ?? 'ninguno'})`)
} catch (e) {
  console.log(`[arnés] no se pudo comprobar la base: ${e.message}`)
}

/**
 * Enlaza los usuarios del arnés con la tabla `usuarios`.
 *
 * El arnés **es** el proveedor de identidad en local, así que conoce los
 * UUID de sus usuarios. La migración siembra el administrador con `auth_uid`
 * en NULL a propósito (en Supabase lo rellena `scripts/arrancar.mjs` con el
 * UUID de Auth); aquí se hace lo mismo, pero con los UUID del arnés.
 *
 * Sin este paso, el login funciona pero la base no resuelve al operador
 * (`fn_usuario_actual()` devuelve NULL) y la consola no abre.
 */
try {
  const servicio = createClient(
    `http://127.0.0.1:${PUERTO_PROXY}`,
    firmarJWT({ role: 'service_role' }),
    { auth: { persistSession: false } },
  )

  const { data: admin, error: eAdmin } = await servicio
    .from('usuarios')
    .update({ auth_uid: USUARIOS['admin@situr.local'].uuid })
    .eq('numero_empleado', 'EMP-0001')
    .select('id, email')

  if (eAdmin) {
    console.log(`[arnés] no se pudo enlazar el administrador: ${eAdmin.message}`)
  } else if (admin?.length) {
    console.log(`[arnés] administrador enlazado: ${admin[0].email} (${admin[0].id})`)
  }

  // El agente: existe en el arnés, así que también en la base.
  const { data: agente } = await servicio
    .from('usuarios')
    .select('id')
    .eq('numero_empleado', 'EMP-0002')
    .maybeSingle()

  if (!agente) {
    const { data: padre } = await servicio
      .from('apellidos')
      .select('id')
      .eq('apellido', 'HERNANDEZ')
      .maybeSingle()
    const { data: rol } = await servicio
      .from('roles')
      .select('id')
      .eq('clave', 'AGENTE')
      .maybeSingle()
    const { data: rolAdmin } = await servicio
      .from('roles')
      .select('id')
      .eq('clave', 'ADMINISTRADOR')
      .maybeSingle()

    if (padre && (rol ?? rolAdmin)) {
      await servicio.from('usuarios').insert({
        auth_uid: USUARIOS['agente@situr.local'].uuid,
        nombres: 'Agente',
        apellido_paterno_id: padre.id,
        email: 'agente@situr.local',
        numero_empleado: 'EMP-0002',
        rol_id: (rol ?? rolAdmin).id,
        activo: true,
        mfa_habilitado: false,
      })
      console.log('[arnés] agente creado (EMP-0002)')
    }
  }
} catch (e) {
  console.log(`[arnés] no se pudieron enlazar los usuarios: ${e.message}`)
}
