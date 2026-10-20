#!/usr/bin/env node
/**
 * SITUR — Enlace local.
 *
 * Pasa de `secretos.env` a `.env.local` **solo** las variables que el
 * navegador puede ver. La `service_role`, la clave privada de VAPID y el
 * `CRON_SECRET` se quedan fuera a propósito: si llegaran al bundle, estarían
 * en el JavaScript que descarga cualquiera.
 *
 * El servidor (`api/`) lee de `secretos.env` por su cuenta a través del
 * plugin de desarrollo, así que tampoco se filtran por ahí.
 *
 * Uso:  node scripts/enlace-local.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')
const secretos = path.join(raiz, 'secretos.env')
const destino = path.join(raiz, '.env.local')

if (!fs.existsSync(secretos)) {
  console.error('Falta secretos.env. Genérelo con: node scripts/generar-secretos.mjs')
  process.exit(1)
}

const origen = {}
for (const linea of fs.readFileSync(secretos, 'utf8').split('\n')) {
  const t = linea.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i < 0) continue
  origen[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}

/**
 * Lo que el navegador puede ver. `VITE_` es el prefijo que Vite inyecta en
 * el bundle; sin él, la variable no sale del servidor de desarrollo.
 */
const PUBLICAS = {
  VITE_SUPABASE_URL: origen.SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: origen.SUPABASE_ANON_KEY,
  VITE_VAPID_PUBLIC_KEY: origen.VAPID_PUBLIC_KEY,
}

const lineas = [
  '# Generado por scripts/enlace-local.mjs — NO editar a mano.',
  '# Solo contiene variables PUBLICAS: lo que ve el navegador.',
  '',
]
for (const [clave, valor] of Object.entries(PUBLICAS)) {
  if (!valor || valor === 'REEMPLAZAR') {
    console.error(`Falta ${clave} en secretos.env`)
    process.exit(1)
  }
  lineas.push(`${clave}=${valor}`)
}
lineas.push('')

fs.writeFileSync(destino, lineas.join('\n'))
console.log(`.env.local escrito con ${Object.keys(PUBLICAS).length} variables públicas.`)
console.log('  (la service_role, la clave privada de VAPID y el CRON_SECRET NO se copian)')
