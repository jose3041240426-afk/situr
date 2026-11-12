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
  entrar: (email: string, password: string) => Promise<ResultadoAcceso>
  verificarMfa: (factorId: string, codigo: string) => Promise<void>
  salir: () => Promise<void>
  recargar: () => Promise<void>
}

/**
 * Resultado de un intento de acceso.
 *
 * `requiereMfa` dice si la contraseña era correcta pero falta el segundo
 * factor: es el caso normal de un operador que ya tiene MFA inscrito, y el
 * que la pantalla de acceso tiene que resolver con el código de seis
 * dígitos.
 */
export interface ResultadoAcceso {
  requiereMfa: boolean
  factorId: string | null
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
    async (email: string, password: string): Promise<ResultadoAcceso> => {
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
        error_code?: string
        factor_id?: string
      }

      /*
       * MFA REQUERIDO (RF-026).
       *
       * Cuando la cuenta ya tiene el segundo factor inscrito, Supabase NO
       * abre la sesión: responde 422 con `error_code: "mfa_required"` y
       * devuelve el factor contra el que hay que verificar, más un token
       * de nivel `aal1` (contraseña comprobada, segundo factor pendiente).
       *
       * Ese token provisional se abre como sesión para poder pedir el reto
       * (`mfa.challenge`). Cuando el operador escriba el código, la sesión
       * sube a `aal2` y el acceso queda completo.
       */
      if (cuerpo.error_code === 'mfa_required' && cuerpo.factor_id) {
        if (cuerpo.access_token && cuerpo.refresh_token) {
          const { error: errSesion } = await supabase.auth.setSession({
            access_token: cuerpo.access_token,
            refresh_token: cuerpo.refresh_token,
          })
          if (errSesion) {
            const mensaje = 'No se pudo preparar la verificación. Vuelva a intentarlo.'
            setError(mensaje)
            throw new Error(mensaje)
          }
        }
        return { requiereMfa: true, factorId: cuerpo.factor_id }
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
      return { requiereMfa: false, factorId: null }
    },
    [recargar],
  )

  /**
   * Verifica el código del segundo factor (RF-026).
   *
   * El reto se pide aquí y no antes: Supabase solo genera un reto por
   * factor cada treinta segundos o así, y pedirlo de antemano lo caducaría
   * mientras el operador escribe el código.
   */
  const verificarMfa = useCallback(
    async (factorId: string, codigo: string) => {
      setError(null)

      const { data: reto, error: errReto } = await supabase.auth.mfa.challenge({
        factorId,
      })
      if (errReto || !reto) {
        const mensaje = 'No se pudo pedir el reto de verificación. Inténtelo de nuevo.'
        setError(mensaje)
        throw new Error(mensaje)
      }

      const { error: errVerifica } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: reto.id,
        code: codigo.trim(),
      })
      if (errVerifica) {
        const mensaje = 'El código no es correcto. Revise el de su aplicación y vuelva a intentarlo.'
        setError(mensaje)
        throw new Error(mensaje)
      }

      await recargar()
    },
    [recargar],
  )

  /**
   * Cerrar la sesión.
   *
   * El estado se limpia ANTES de hablar con el servidor: la pantalla de acceso
   * tiene que aparecer en el mismo gesto. Antes se esperaba a
   * `signOut()` y, si el servidor de autenticación tarda (o no contesta, como
   * pasa en el arnés local, que no implementa `/auth/v1/logout`), la consola se
   * quedaba congelada con el botón pulsado.
   *
   * `scope: 'local'` cierra la sesión en este navegador sin pedirle permiso al
   * servidor: borra el token guardado y ya está. Es lo que hace falta aquí —no
   * hay sesiones compartidas entre equipos— y quita la ida y vuelta de red del
   * camino crítico.
   */
  const salir = useCallback(async () => {
    setOperador(null)
    setSesion(null)
    setEsAdministrador(false)
    setPuedeOperar(false)

    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch {
      /*
       * Si ni siquiera el borrado local funciona, la sesión del estado ya
       * está cerrada y el usuario está fuera de la consola: no hay nada que
       * hacer aquí, y un error rojo al salir sería ruido.
       */
    }
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
      verificarMfa,
      salir,
      recargar,
    }),
    [
      sesion,
      operador,
      cargando,
      esAdministrador,
      puedeOperar,
      error,
      entrar,
      verificarMfa,
      salir,
      recargar,
    ],
  )

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}

export function useAuth(): ContextoAuth {
  const ctx = useContext(Contexto)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <ProveedorAuth>')
  return ctx
}
