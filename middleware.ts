import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * SITUR — Vercel Edge Middleware: límite de tasa (DRS §10).
 *
 * Su única misión es **contener peticiones**. No contiene lógica de negocio
 * de turnos: eso vive en PostgreSQL (DRS §6). Un turno no se llama desde
 * aquí.
 *
 * DRS §10 pide aplicarlo a:
 *   * la consulta pública (IP + token),
 *   * el login (IP + cuenta),
 *   * la regeneración de QR (usuario),
 *   * las operaciones administrativas sensibles,
 *   * y desde la v1.5, el envío de push y el alta de suscripciones (IP + token).
 *
 * Sin CAPTCHA como mecanismo principal.
 *
 * Si no hay Upstash configurado el middleware deja pasar: es preferible un
 * despliegue sin límite a un despliegue que no arranca.
 */
const redis = process.env.UPSTASH_REDIS_REST_URL ? Redis.fromEnv() : null

type Ventana = `${number} ${'s' | 'm' | 'h' | 'd'}`

/**
 * Crea un limitador. `identificador` es asíncrono porque para el alta de
 * suscripciones hay que leer el cuerpo de la petición, y el cuerpo solo se
 * puede leer una vez: por eso se clona la petición.
 */
function limitador(
  nombre: string,
  requests: number,
  ventana: Ventana,
  identificador: (req: NextRequest) => Promise<string>,
) {
  if (!redis) return null
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, ventana),
    prefix: `situr:${nombre}`,
    analytics: true,
  })
  return async (req: NextRequest) => {
    const id = await identificador(req)
    const { success, limit, reset } = await ratelimit.limit(id)
    if (success) return null
    const espera = Math.max(0, Math.ceil((reset - Date.now()) / 1000))
    return NextResponse.json(
      { error: 'Demasiadas peticiones. Inténtelo de nuevo en unos segundos.' },
      {
        status: 429,
        headers: {
          'retry-after': String(espera),
          'x-ratelimit-limit': String(limit),
          'x-ratelimit-reset': String(reset),
        },
      },
    )
  }
}

/**
 * Identificador de red para el límite de tasa, **truncado**.
 *
 * Una dirección IP completa es dato personal: identifica a una persona o a su
 * conexión, y aquí se guardaría en Upstash, que puede estar en otro país.
 * Por eso no se guarda completa: se conserva el prefijo de red (una IPv4 /24
 * son hasta 256 direcciones; una IPv6 /64, un bloque enorme) y se descarta
 * el identificador del host.
 *
 * El límite sigue funcionando igual de bien: lo que se quiere frenar es el
 * abuso desde una conexión, y un /24 es una unidad de abuso.
 */
const prefijoRed = (direccion: string): string => {
  const ip = direccion.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').slice(0, 3).join('.') + '.0/24'
  }
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':') + '::/64'
  }
  return 'desconocido'
}

const ip = (req: NextRequest) =>
  prefijoRed(
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      'desconocido',
  )

/** Lee un campo del cuerpo sin consumarlo: se clona la petición. */
async function campoDelCuerpo(req: NextRequest, campo: string): Promise<string | null> {
  try {
    const clon = req.clone()
    const texto = await clon.text()
    if (!texto) return null
    const datos = JSON.parse(texto) as Record<string, unknown>
    const valor = datos[campo]
    return typeof valor === 'string' ? valor : null
  } catch {
    return null
  }
}

/** Consulta pública del ciudadano: se limita por IP **y** por token. */
const limiteConsulta = limitador('consulta', 30, '1 m', async (req) => {
  const token = req.nextUrl.searchParams.get('token') ?? ''
  return `${ip(req)}:${token.slice(0, 12)}`
})

/** Alta de suscripción push: IP + token, para que nadie reguere suscripciones. */
const limiteSuscripcion = limitador('suscripcion', 10, '1 m', async (req) => {
  const token =
    req.nextUrl.searchParams.get('token') ?? (await campoDelCuerpo(req, 'token')) ?? ''
  return `${ip(req)}:${token.slice(0, 12)}`
})

/**
 * Login: se limita por IP y por cuenta para frenar la fuerza bruta.
 * Cuenta el intento, no la respuesta: un login fallido y uno bueno cuentan
 * igual, que es lo que frena la fuerza bruta.
 */
const limiteLogin = limitador('login', 10, '10 m', async (req) => {
  const cuenta = (await campoDelCuerpo(req, 'email')) ?? 'desconocida'
  return `${ip(req)}:${cuenta.toLowerCase()}`
})

/**
 * Consulta pública del turno: por IP y por token.
 *
 * Solo cuenta si la petición pasa por aquí, y por eso el cliente llama a
 * `/api/turno` y no directamente a Supabase (ver `api/turno.ts`).
 */
const limiteConsultaApi = limitador('consulta-api', 30, '1 m', async (req) => {
  const token = req.nextUrl.searchParams.get('token') ?? ''
  return `${ip(req)}:${token.slice(0, 12)}`
})

/**
 * La pantalla pública (RF-020). Sondea cada 5 s, y en una ventanilla puede
 * haber varias pantallas detrás de la misma conexión: el límite va por
 * prefijo de red, con margen de sobra para las pantallas reales y sin dar
 * margen a un barrido.
 */
const limitePantalla = limitador('pantalla', 120, '1 m', async (req) => ip(req))

/** El emisor de push: lo llama el cron, no una persona. */
const limitePush = limitador('push', 10, '1 m', async (req) => ip(req))

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Las peticiones al API de push las cuenta el cron, no el usuario.
  if (pathname === '/api/push') {
    const bloqueo = await limitePush?.(req)
    if (bloqueo) return bloqueo
  }

  // El alta y la baja de suscripciones push también se limitan por IP + token
  // (DRS §10): sin esto, un registro de suscripciones sería gratis.
  if (pathname === '/api/suscripcion') {
    const bloqueo = await limiteSuscripcion?.(req)
    if (bloqueo) return bloqueo
  }

  // La consulta pública viaja con el token en la URL (así funciona el QR:
  // no hay cuerpo, no hay cookies).
  if (pathname.startsWith('/turno/')) {
    const bloqueo = await limiteConsulta?.(req)
    if (bloqueo) return bloqueo
  }

  // El acceso del operador: la contraseña viaja por aquí, y así se puede
  // contar y frenar (DRS §10).
  if (pathname === '/api/login' && req.method === 'POST') {
    const bloqueo = await limiteLogin?.(req)
    if (bloqueo) return bloqueo
  }

  // La consulta pública del turno: la ruta por la que el ciudadano pide sus
  // datos. El límite va aquí, en la ruta que sí se usa.
  if (pathname === '/api/turno' && req.method === 'GET') {
    const bloqueo = await limiteConsultaApi?.(req)
    if (bloqueo) return bloqueo
  }

  // La pantalla pública de la sala de espera (RF-020). También es anónima,
  // también es pública y también se puede pedir en bucle.
  if (pathname === '/api/ultimas-llamadas' && req.method === 'GET') {
    const bloqueo = await limitePantalla?.(req)
    if (bloqueo) return bloqueo
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)'],
}
