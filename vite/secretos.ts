import fs from 'node:fs'
import path from 'node:path'

/**
 * SITUR — Lectura de `secretos.env`.
 *
 * `secretos.env` es el archivo con TODOS los secretos (VAPID, service_role,
 * CRON_SECRET). `.env.local` solo lleva lo público, porque Vite mete todo lo
 * que empieza por `VITE_` en el bundle del navegador.
 *
 * El servidor (`api/`) lee de `secretos.env`; el navegador, de `.env.local`.
 * Esta función la usa el plugin de desarrollo para que las funciones de
 * `api/` finding el camino de vuelta a los secretos.
 */
export function leerSecretos(rutaApp: string): Record<string, string> {
  const archivo = path.join(rutaApp, 'secretos.env')
  if (!fs.existsSync(archivo)) return {}

  const salida: Record<string, string> = {}
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    const t = linea.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    salida[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return salida
}
