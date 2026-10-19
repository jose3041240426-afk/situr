import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

/**
 * SITUR — Monta las funciones de `api/` en el servidor de desarrollo.
 *
 * En Vercel, `api/push.ts` y `api/suscripcion.ts` son Serverless Functions.
 * En `npm run dev` no existen: por eso el alta de la suscripción push se
 * quedaba a medias y la citizen page caía en su rama de respaldo.
 *
 * Este plugin convierte los manejadores (que usan la firma de Vercel:
 * `Request -> Response`) en middleware de Vite. No cambia nada del código de
 * las funciones: en producción siguen siendo Serverless Functions.
 */
export function apiEnDesarrollo(
  rutaApi = 'api',
  entorno: Record<string, string> = {},
): Plugin {
  // El plugin vive en `vite/`, así que la carpeta `api/` está un nivel arriba.
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const carpeta = path.resolve(raiz, rutaApi)

  return {
    name: 'situr:api-en-desarrollo',
    apply: 'serve',
    configureServer(servidor: ViteDevServer) {
      // Las funciones de `api/` leen de `process.env`. En desarrollo se
      // inyectan desde el mismo `.env.local` que usa el navegador.
      for (const [clave, valor] of Object.entries(entorno)) {
        if (valor && !process.env[clave]) process.env[clave] = valor
      }

      if (!fs.existsSync(carpeta)) return

      servidor.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, siguiente: () => void) => {
          const url = req.url ?? '/'
          if (!url.startsWith('/api/')) return siguiente()

          const nombre = url.split('?')[0].replace(/^\/api\//, '')
          const archivo = path.join(carpeta, `${nombre}.ts`)

          if (!fs.existsSync(archivo)) {
            res.statusCode = 404
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: `No existe la función api/${nombre}.ts` }))
            return
          }

          try {
            const modulo = (await import(archivo)) as {
              default?: (peticion: Request) => Promise<Response>
            }
            const manejador = modulo.default
            if (typeof manejador !== 'function') {
              throw new Error(`api/${nombre}.ts no exporta una función por defecto`)
            }

            const peticion = await nodeAPeticion(req)
            const respuesta = await manejador(peticion)

            res.statusCode = respuesta.status
            respuesta.headers.forEach((valor, clave) => res.setHeader(clave, valor))
            const cuerpo = await respuesta.text()
            res.end(cuerpo)
          } catch (e) {
            const mensaje = e instanceof Error ? e.message : String(e)
            servidor.config.logger.error(`[api] ${nombre}: ${mensaje}`)
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: mensaje }))
          }
        },
      )
    },
  }
}

/** Convierte la petición de Node en una `Request` web. */
async function nodeAPeticion(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`
  const cabeceras = new Headers()
  for (const [clave, valor] of Object.entries(req.headers)) {
    if (valor !== undefined) cabeceras.set(clave, Array.isArray(valor) ? valor.join(', ') : valor)
  }

  let cuerpo: Buffer | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    cuerpo = await new Promise<Buffer>((resolver) => {
      const trozos: Buffer[] = []
      req.on('data', (t: Buffer) => trozos.push(t))
      req.on('end', () => resolver(Buffer.concat(trozos)))
    })
  }

  return new Request(url, {
    method: req.method ?? 'GET',
    headers: cabeceras,
    body: cuerpo && cuerpo.length > 0 ? cuerpo : undefined,
  })
}
