import { createClient } from '@supabase/supabase-js'

/**
 * SITUR — Últimas llamadas para la pantalla pública (RF-020, DRS §10).
 *
 * ¿POR QUÉ EXISTE ESTE ENDPOINT, Y NO LLAMAR A SUPABASE DESDE EL NAVEGADOR?
 *
 * Por lo mismo que `/api/turno`, y con más razón aquí:
 *
 *   1. La pantalla pública es **anónima**: no hay token, no hay cuenta, no
 *      hay sesión. Si el navegador pidiera los turnos directamente a
 *      Supabase, la RLS lo negaría (como ocurría: la pantalla se quedaba
 *      siempre en «Espere a que se llamen los turnos»). Y con la
 *      `service_role` la RLS dejaría de aplicar, y entonces sí se vería
 *      todo. Esta ruta usa la clave **anon** y una RPC pública controlada.
 *   2. El DRS §10 pide limitar por IP las peticiones públicas. Por aquí
 *      pasan, y por eso el límite existe de verdad.
 *
 * Lo que sale de aquí son cuatro campos por llamada: código del turno,
 * módulo, trámite y hora. Ni token, ni folio, ni nombre, ni motivo. Es lo
 * que se puede escribir en un cartel de la sala de espera sin decirle nada
 * a nadie.
 */
export const config = { runtime: 'nodejs' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Configuracion incompleta.' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  // La RPC acota el límite a 20 por su cuenta; aquí solo se pide un número
  // pequeño y nunca se acepta lo que pida el cliente sin tope.
  const url = new URL(req.url)
  const pedido = Number.parseInt(url.searchParams.get('limite') ?? '8', 10)
  const limite = Number.isFinite(pedido) ? Math.min(Math.max(pedido, 1), 20) : 8

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.rpc('ultimas_llamadas', { p_limite: limite })

  if (error) {
    return new Response(
      JSON.stringify({ error: 'No se pudieron obtener las últimas llamadas.' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  return new Response(JSON.stringify({ llamadas: data ?? [] }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // La pantalla sondea cada 5 s: sin esto, el navegador pediría lo mismo
      // una y otra vez. Un segundo de margen es suficiente y no arriesga
      // que alguien lea una llamada de más.
      'cache-control': 'public, max-age=1',
    },
  })
}
