#!/usr/bin/env node
/**
 * SITUR — Generador de secretos de instalación.
 *
 * Crea `secretos.env` con:
 *   * el par de claves VAPID del Web Push (público para el navegador,
 *     privado solo para el servidor),
 *   * un `CRON_SECRET` para autorizar al cron a llamar a `/api/push`,
 *   * una contraseña de un solo uso para el administrador de arranque.
 *
 * Los datos del proyecto Supabase y de Upstash se dejan en `REEMPLAZAR`:
 * son de la cuenta del cliente y no se pueden generar desde aquí.
 *
 * El archivo sale con permisos 600 y está en `.gitignore`.
 *
 * Uso:  node scripts/generar-secretos.mjs [--sobrescribir]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')
const destino = path.join(raiz, 'secretos.env')

if (fs.existsSync(destino) && !process.argv.includes('--sobrescribir')) {
  console.error(`${destino} ya existe. Use --sobrescribir para regenerarlo.`)
  console.error('OJO: regenerarlo invalida las claves VAPID ya suscritas.')
  process.exit(1)
}

const vapid = webpush.generateVAPIDKeys()
const cronSecret = crypto.randomBytes(32).toString('base64url')
const claveAdmin = crypto.randomBytes(18).toString('base64url')
const hoy = new Date().toISOString().slice(0, 10)

const contenido = `# ============================================================================
# SITUR — Secretos de la instalación
#
# Este archivo NO se sube al repositorio (app/.gitignore lo excluye).
# Generado el ${hoy}.
#
# Para desplegar:  scripts/desplegar.sh   (los pasa a Vercel)
# Para arrancar:   scripts/arrancar.mjs
# ============================================================================

# --- Proyecto Supabase (Settings > API) -----------------------------------
SUPABASE_URL=https://REEMPLAZAR.supabase.co
SUPABASE_ANON_KEY=REEMPLAZAR
SUPABASE_SERVICE_ROLE_KEY=REEMPLAZAR

# --- Administrador de arranque --------------------------------------------
# scripts/arrancar.mjs crea este usuario en Supabase Auth y lo enlaza con
# usuarios.auth_uid. La contraseña es de un solo uso: cámbiela en el primer
# acceso, junto con la inscripción del segundo factor (RF-026).
SITUR_ADMIN_EMAIL=admin@catastro.durango.gob.mx
SITUR_ADMIN_PASSWORD=${claveAdmin}

# --- Web Push (VAPID) ------------------------------------------------------
# La pública va al navegador (VITE_VAPID_PUBLIC_KEY); la privada, SOLO al
# servidor (VAPID_PRIVATE_KEY).
VAPID_PUBLIC_KEY=${vapid.publicKey}
VAPID_PRIVATE_KEY=${vapid.privateKey}
VAPID_SUBJECT=mailto:catastro@durango.gob.mx

# --- Autorización del cron ------------------------------------------------
# El cron de Vercel llama a POST /api/push con Authorization: Bearer <valor>.
# Sin este valor, /api/push se rechaza en produccion: es lo correcto, porque
# mejor no enviar avisos que dejarlos abiertos a internet (DRS §10).
CRON_SECRET=${cronSecret}

# --- Upstash Redis (límite de tasa del Edge Middleware) --------------------
# Si se dejan en REEMPLAZAR, el middleware deja pasar: es preferible un
# despliegue sin límite a un despliegue que no arranca.
UPSTASH_REDIS_REST_URL=REEMPLAZAR
UPSTASH_REDIS_REST_TOKEN=REEMPLAZAR
`

fs.writeFileSync(destino, contenido, { mode: 0o600 })
console.log(`secretos.env escrito (permisos 600)`)
console.log(`  VAPID pública : ${vapid.publicKey.slice(0, 24)}...`)
console.log(`  CRON_SECRET   : ${cronSecret.slice(0, 8)}...`)
console.log(`  clave admin   : ${claveAdmin}`)
console.log('')
console.log('Falta rellenar: SUPABASE_URL, las dos claves de Supabase y las de Upstash.')
