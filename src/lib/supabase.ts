import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SITUR — Cliente de Supabase.
 *
 * DRS §6: Supabase aporta Auth, RLS, RPC y Realtime. **PostgreSQL es la
 * autoridad**: los estados, la concurrencia y la auditoría se resuelven en la
 * base, nunca en el cliente.
 *
 * DRS §10: elEdge Middleware (Vercel) limita las peticiones; el cliente no
 * implementa throttling propio.
 *
 * La clave que se usa aquí es la **anon key**. Con ella el rol `anon`/`authenticated`
 * queda sujeto a la RLS: el ciudadano no tiene ni SELECT sobre `turnos` (RF-019)
 * y solo puede llamar a `get_turno_publico` y a las dos RPC de suscripción push.
 */

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * El cliente es único por pestaña: Supabase mantiene la sesión en este objeto.
 *
 * Si falta la configuración, `createClient` **lanza** («supabaseUrl is
 * required»), y el fallo ocurre al importar el módulo: antes de que React
 * pueda pintar nada. Así que el aviso de «Falta la configuración de Supabase»
 * que hay en `App.tsx` no llegaba a verse nunca, y quien arrancaba la
 * aplicación sin `.env.local` se encontraba con un error en blanco.
 *
 * Aquí se crea un cliente **inerte** con una dirección de relleno: la
 * aplicación no llega a usarlo, porque `hayConfiguracion()` es falso y
 * `App` enseña el aviso en su lugar.
 */
export const supabase: SupabaseClient = createClient(
  url || 'http://localhost:0',
  anonKey || 'sin-configuracion',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
    global: {
      headers: { 'x-application-name': 'situr' },
    },
  },
)

/**
 * Crea un cliente con la `service_role`. **Solo para el servidor** (la función
 * `/api/push`): la service_role se salta la RLS, así que jamás debe llegar al
 * navegador. La cola de avisos es la única RPC que la necesita.
 */
export function crearClienteServicio(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function hayConfiguracion(): boolean {
  return Boolean(url && anonKey)
}
