import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabase'

/**
 * SITUR — Sesión y rol del operador.
 *
 * DRS RF-001: el acceso es solo para usuarios administrativos registrados
 * (Supabase Auth). RF-002: el rol vive en la base y se valida en la
 * aplicación **y** en la capa de datos. RF-026: sin MFA configurado no se
 * permiten funciones privilegiadas.
 *
 * El rol no se deduce del JWT: se pregunta a la base, que es la autoridad
 * (RG-003: cada entidad se identifica por su columna propia).
 */

export interface Operador {
  id: string
  nombres: string
  email: string
  numero_empleado: string
  rol: string
  modulo: string | null
  activo: boolean
  mfaHabilitado: boolean
}

interface ContextoAuth {
  sesion: Session | null
  usuario: User | null
  operador: Operador | null
  cargando: boolean
  esAdministrador: boolean
  puedeOperar: boolean
  mfaPendiente: boolean
  error: string | null
  entrar: (email: string, password: string) => Promise<void>
  salir: () => Promise<void>
  recargar: () => Promise<void>
}

const Contexto = createContext<ContextoAuth | null>(null)

export function ProveedorAuth({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Session | null>(null)
  const [operador, setOperador] = useState<Operador | null>(null)
  const [esAdministrador, setEsAdministrador] = useState(false)
  const [puedeOperar, setPuedeOperar] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase.auth.getSession()
    if (err) {
      setError(err.message)
      setCargando(false)
      return
    }
    setSesion(data.session)
    if (!data.session) {
      setOperador(null)
      setEsAdministrador(false)
      setPuedeOperar(false)
      setCargando(false)
      return
    }

    // El operador se resuelve con `fn_usuario_actual()`, que devuelve el UUID
    // del usuario a partir de `auth.uid()` (nunca se pasa como parámetro: la
    // base lo deduce de la sesión). Con ese UUID se lee su fila por la
    // política `p_usuarios_propio`, que permite ver la propia.
    const { data: opId, error: errOp } = await supabase.rpc('fn_usuario_actual')
    if (errOp || !opId) {
      // Hay sesión pero no hay registro activo en `usuarios`: el acceso no
      // está autorizado (RF-003 solo habilita a usuarios dados de alta).
      setOperador(null)
      setEsAdministrador(false)
      setPuedeOperar(false)
      setCargando(false)
      return
    }

    const { data: fila, error: errFila } = await supabase
      .from('usuarios')
      .select(
        'id, nombres, email, numero_empleado, activo, mfa_habilitado, ' +
          'rol:roles!fk_usuarios_roles(clave), ' +
          'modulo:modulos!fk_usuarios_modulos(codigo)',
      )
      .eq('id', opId)
      .single()

    if (errFila || !fila) {
      setOperador(null)
      setEsAdministrador(false)
      setPuedeOperar(false)
      setCargando(false)
      return
    }

    const f = fila as unknown as {
      id: string
      nombres: string
      email: string
      numero_empleado: string
      activo: boolean
      mfa_habilitado: boolean
      rol: { clave: string } | null
      modulo: { codigo: string } | null
    }

    setOperador({
      id: f.id,
      nombres: f.nombres,
      email: f.email,
      numero_empleado: f.numero_empleado,
      rol: f.rol?.clave ?? 'ADMINISTRADOR',
      modulo: f.modulo?.codigo ?? null,
      activo: f.activo,
      mfaHabilitado: f.mfa_habilitado,
    })

    const [{ data: esAdmin }, { data: puedeOp }] = await Promise.all([
      supabase.rpc('fn_es_administrador'),
      supabase.rpc('fn_puede_operar_turnos'),
    ])
    setEsAdministrador(esAdmin === true)
    setPuedeOperar(puedeOp === true)
    setCargando(false)
  }, [])

  useEffect(() => {
    void recargar()
    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      void recargar()
    })
    return () => listener.subscription.unsubscribe()
  }, [recargar])

  const entrar = useCallback(
    async (email: string, password: string) => {
      setError(null)

      // El intento va contra `/api/login` y no directamente contra Supabase:
      // el DRS §10 pide limitar por IP y por cuenta los intentos de acceso, y
      // una llamada directa a `supabase.co` nunca pasa por el Edge Middleware.
      const respuesta = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const cuerpo = (await respuesta.json().catch(() => ({}))) as {
        access_token?: string
        refresh_token?: string
        error?: string
        msg?: string
      }

      if (!respuesta.ok || !cuerpo.access_token || !cuerpo.refresh_token) {
        const mensaje =
          cuerpo.error === 'Invalid login credentials' || cuerpo.msg === 'Invalid login credentials'
            ? 'Correo o contraseña incorrectos.'
            : (cuerpo.error ?? cuerpo.msg ?? 'No se pudo iniciar sesión.')
        setError(mensaje)
        throw new Error(mensaje)
      }

      // La sesión se abre en el cliente con los tokens que devolvió Supabase.
      const { error: errSesion } = await supabase.auth.setSession({
        access_token: cuerpo.access_token,
        refresh_token: cuerpo.refresh_token,
      })
      if (errSesion) {
        setError('No se pudo abrir la sesión. Vuelva a intentarlo.')
        throw errSesion
      }

      await recargar()
    },
    [recargar],
  )

  const salir = useCallback(async () => {
    await supabase.auth.signOut()
    setOperador(null)
    setSesion(null)
    setEsAdministrador(false)
    setPuedeOperar(false)
  }, [])

  const valor = useMemo<ContextoAuth>(
    () => ({
      sesion,
      usuario: sesion?.user ?? null,
      operador,
      cargando,
      esAdministrador,
      puedeOperar,
      // RF-026: la inscripción de MFA es obligatoria en el primer acceso.
      mfaPendiente: Boolean(operador?.activo) && !operador?.mfaHabilitado,
      error,
      entrar,
      salir,
      recargar,
    }),
    [sesion, operador, cargando, esAdministrador, puedeOperar, error, entrar, salir, recargar],
  )

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}

export function useAuth(): ContextoAuth {
  const ctx = useContext(Contexto)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <ProveedorAuth>')
  return ctx
}
