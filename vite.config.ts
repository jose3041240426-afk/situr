import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { apiEnDesarrollo } from './vite/api-en-desarrollo'
import { leerSecretos } from './vite/secretos'

/**
 * DRS §6: React + TypeScript, desplegado en Vercel.
 * El backend es Supabase (PostgreSQL) y la lógica de turnos vive en las RPC;
 * el cliente no habla nunca con las tablas base.
 */
export default defineConfig(({ mode }) => {
  // Tres archivos, por público:
  //   .env.local   -> lo que ve el NAVEGADOR (solo variables VITE_*), y en
  //                   desarrollo el override del arnés local
  //   secretos.env -> lo que ve el SERVIDOR en producción (VAPID privado,
  //                   service_role...) y el punto de partida en desarrollo
  //   entorno      -> lo que cargue Vite (.env, .env.local, .env.[modo])
  //
  // En DESARROLLO manda `.env.local`: es lo que escribe
  // `pruebas/levantar.sh` para apuntar TODO (navegador y servidor) al arnés
  // local. Sin esa precedencia, las funciones de `api/` hablarían con el
  // proyecto de Supabase de `secretos.env` mientras el navegador habla con
  // el arnés: dos bases distintas, y un error muy difícil de ver.
  const entorno = loadEnv(mode, process.cwd(), '')
  const secretos = leerSecretos(process.cwd())

  const elegir = (...candidatos: (string | undefined)[]) =>
    candidatos.find((v) => v && v !== 'REEMPLAZAR') ?? ''

  const variablesServidor: Record<string, string> = {
    SUPABASE_URL: elegir(
      entorno.SUPABASE_URL,
      secretos.SUPABASE_URL,
      entorno.VITE_SUPABASE_URL,
    ),
    SUPABASE_ANON_KEY: elegir(
      entorno.SUPABASE_ANON_KEY,
      secretos.SUPABASE_ANON_KEY,
      entorno.VITE_SUPABASE_ANON_KEY,
    ),
    SUPABASE_SERVICE_ROLE_KEY: elegir(
      entorno.SUPABASE_SERVICE_ROLE_KEY,
      secretos.SUPABASE_SERVICE_ROLE_KEY,
    ),
    VAPID_PUBLIC_KEY: elegir(
      entorno.VAPID_PUBLIC_KEY,
      secretos.VAPID_PUBLIC_KEY,
      entorno.VITE_VAPID_PUBLIC_KEY,
    ),
    VAPID_PRIVATE_KEY: elegir(entorno.VAPID_PRIVATE_KEY, secretos.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: elegir(
      entorno.VAPID_SUBJECT,
      secretos.VAPID_SUBJECT,
      'mailto:catastro@durango.gob.mx',
    ),
    CRON_SECRET: elegir(entorno.CRON_SECRET, secretos.CRON_SECRET),
  }

  return {
    plugins: [react(), tailwindcss(), apiEnDesarrollo('api', variablesServidor)],
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    // Sin `define` para process.env: las funciones de `api/` leen de
    // `process.env` de verdad (en desarrollo, el plugin lo inyecta desde
    // `secretos.env`; en produccion, Vercel lo pone). Ponerlas aqui las
    // meteria tambien en el bundle del navegador, y la `service_role` no
    // puede llegar ahi ni por error.
  }
})
