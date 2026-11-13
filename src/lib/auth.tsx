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
  /** Los apellidos vienen del catálogo `apellidos`, no de un campo de texto. */
  apellidoPaterno: string | null
  apellidoMaterno: string | null
  email: string
  numero_empleado: string
  /** La clave del rol: ADMINISTRADOR, SUPERVISOR o AGENTE. */
  rol: string
  /** El nombre legible del rol («Administrador», «Agente de ventanilla»). */
  rolNombre: string
  /** Qué puede hacer ese rol, en una frase. */
  rolDescripcion: string | null
  modulo: string | null
  /** El nombre de la ventanilla donde opera. */
  moduloNombre: string | null
  activo: boolean
  mfaHabilitado: boolean
  /** Cuándo se dio de alta la cuenta. */
  creadoEn: string
  /** Cuándo se tocó por última vez. */
  actualizadoEn: string
}

interface ContextoAuth {
  sesion: Session | null
  usuario: User | null
  operador: Operador | null
  cargando: boolean
  esAdministrador: boolean
  esRecepcion: boolean
  esAgente: boolean
  puedeOperar: boolean
  mfaPendiente: boolean
  /**
   * El operador tiene MFA inscrito y la sesión actual es de UN solo factor
   * (`aal1`): falta el código de verificación.
   *
   * Supabase no avisa de esto en el intercambio de contraseña —entrega la
   * sesión tal cual—, así que hay que mirar el nivel de la sesión y los
   * factores del usuario. Sin esta comprobación, un operador con MFA
   * entraba a la consola sin el segundo factor.
   */
  mfaRequerido: boolean
  /** Factor contra el que hay que verificar el código. */
  factorMfa: string | null
  /** Ya se sabe si hace falta el segundo factor. */
  verificacionResuelta: boolean
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

/**
 * Lee el nivel de garantía del token (`aal`) sin pedirlo al servidor.
 *
 * El JWT lleva laclaim `aal`: `aal1` es solo la contraseña, `aal2` es
 * contraseña más un factor verificado. Se lee a mano porque son tres líneas
 * y una llamada de red por cada recarga de la sesión es de más.
 */
export function leerNivelAal(token: string | undefined): string | null {
  if (!token) return null
  try {
    const carga = token.split('.')[1]
    if (!carga) return null
    const json = atob(carga.replace(/-/g, '+').replace(/_/g, '/'))
    return (JSON.parse(json) as { aal?: string }).aal ?? null
  } catch {
    return null
  }
}

export function ProveedorAuth({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Session | null>(null)
  const [operador, setOperador] = useState<Operador | null>(null)
  const [esAdministrador, setEsAdministrador] = useState(false)
  const [esRecepcion, setEsRecepcion] = useState(false)
  const [puedeOperar, setPuedeOperar] = useState(false)
  const [mfaRequerido, setMfaRequerido] = useState(false)
  const [factorMfa, setFactorMfa] = useState<string | null>(null)
  const [verificacionResuelta, setVerificacionResuelta] = useState(false)
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
      setEsRecepcion(false)
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
      setEsRecepcion(false)
      setPuedeOperar(false)
      setCargando(false)
      return
    }

    const { data: fila, error: errFila } = await supabase
      .from('usuarios')
      .select(
        'id, nombres, email, numero_empleado, activo, mfa_habilitado, ' +
          'creado_en, actualizado_en, ' +
          'apellido_paterno:apellidos!fk_usuarios_apellido_paterno(apellido), ' +
          'apellido_materno:apellidos!fk_usuarios_apellido_materno(apellido), ' +
          'rol:roles!fk_usuarios_roles(clave, nombre, descripcion), ' +
          'modulo:modulos!fk_usuarios_modulos(codigo, denominacion)',
      )
      .eq('id', opId)
      .single()

    if (errFila || !fila) {
      setOperador(null)
      setEsAdministrador(false)
      setEsRecepcion(false)
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
      creado_en: string
      actualizado_en: string
      /*
       * Los apellidos vienen del catálogo `apellidos` por una clave
       * foránea, así que PostgREST los devuelve como OBJETO
       * (`{apellido: '…'}`), no como texto. Sin sacar el campo, el nombre
       * completo salía como «Prueba [object Object]».
       */
      apellido_paterno: { apellido: string } | null
      apellido_materno: { apellido: string } | null
      rol: { clave: string; nombre: string; descripcion: string | null } | null
      modulo: { codigo: string; denominacion: string } | null
    }

    setOperador({
      id: f.id,
      nombres: f.nombres,
      apellidoPaterno: f.apellido_paterno?.apellido ?? null,
      apellidoMaterno: f.apellido_materno?.apellido ?? null,
      email: f.email,
      numero_empleado: f.numero_empleado,
      rol: f.rol?.clave ?? 'ADMINISTRADOR',
      rolNombre: f.rol?.nombre ?? 'Administración',
      rolDescripcion: f.rol?.descripcion ?? null,
      modulo: f.modulo?.codigo ?? null,
      moduloNombre: f.modulo?.denominacion ?? null,
      activo: f.activo,
      mfaHabilitado: f.mfa_habilitado,
      creadoEn: f.creado_en,
      actualizadoEn: f.actualizado_en,
    })

    const [{ data: esAdmin }, { data: esRec }, { data: puedeOp }] = await Promise.all([
      supabase.rpc('fn_es_administrador'),
      supabase.rpc('fn_es_recepcion'),
      supabase.rpc('fn_puede_operar_turnos'),
    ])
    setEsAdministrador(esAdmin === true)
    setEsRecepcion(esRec === true)
    setPuedeOperar(puedeOp === true)

    /*
     * ¿FALTA EL SEGUNDO FACTOR?
     *
     * `aal` es el nivel de garantía del token: `aal1` es solo la contraseña,
     * `aal2` es contraseña más un factor. Se lee del propio token, sin
     * pedirlo al servidor, así que no cuesta una llamada.
     *
     * Si el operador tiene MFA inscrito y la sesión es `aal1`, falta el
     * código. Es el caso normal después de escribir la contraseña: Supabase
     * abre la sesión de un factor y deja el segundo pendiente.
     */
    const aal = leerNivelAal(data.session?.access_token)
    let verificadoId: string | null = null
    if (f.mfa_habilitado && aal === 'aal1') {
      const { data: factores } = await supabase.auth.mfa.listFactors()
      const verificado = factores?.totp?.find((x) => x.status === 'verified')
      verificadoId = verificado?.id ?? null
    }
    setMfaRequerido(verificadoId !== null)
    setFactorMfa(verificadoId)

    /*
     * `verificacionResuelta` dice que ya se sabe si falta el código.
     *
     * Sin esta guarda, la pantalla de acceso saltaba a la consola antes de
     * tiempo: `setOperador()` provoca un render, y en ese render todavía no
     * se sabe que hace falta el segundo factor, así que la navegación se
     * disparaba y el operador entraba sin escribir el código. Los tres
     * estados de abajo se fijan juntos, en un mismo render, y la guarda
     * frena la navegación hasta que están los tres.
     */
    setVerificacionResuelta(true)
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

      /*
       * MFA REQUERIDO (RF-026).
       *
       * Supabase NO devuelve `mfa_required` en el intercambio de contraseña:
       * entrega una sesión de UN solo factor (`aal: aal1`), con la contraseña
       * comprobada y el segundo factor pendiente. Por eso no hay que esperar
       * una señal del servidor: hay que MIRAR si el usuario tiene un factor
       * verificado y, si lo tiene, pedirle el código.
       *
       * `listFactors()` devuelve los factores del usuario con su estado; solo
       * se consideran los verificados, que son los que sirven de segundo
       * factor de verdad.
       */
      const { data: factores } = await supabase.auth.mfa.listFactors()
      const verificado = factores?.totp?.find((f) => f.status === 'verified')

      if (verificado) {
        return { requiereMfa: true, factorId: verificado.id }
      }

      return { requiereMfa: false, factorId: null }
    },
    [recargar],
  )

  /**
   * Verifica el código del segundo factor (RF-026).
   *
   * `challengeAndVerify` pide el reto y comprueba el código en una sola
   * llamada. El reto NO se pide antes: Supabase lo caduca a los treinta
   * segundos, así que pedirlo de antemano lo invalidaría mientras el
   * operador escribe el código.
   */
  const verificarMfa = useCallback(
    async (factorId: string, codigo: string) => {
      setError(null)

      const { error: errVerifica } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: codigo.trim(),
      })
      if (errVerifica) {
        const mensaje = 'El código no es correcto. Revise el de su aplicación.'
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
    setEsRecepcion(false)
    setPuedeOperar(false)
    setMfaRequerido(false)
    setFactorMfa(null)
    setVerificacionResuelta(false)

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
      esRecepcion,
      esAgente: operador?.rol === 'AGENTE',
      puedeOperar,
      // RF-026: la inscripción de MFA es obligatoria en el primer acceso.
      mfaPendiente: Boolean(operador?.activo) && !operador?.mfaHabilitado,
      // Y en cada acceso posterior hay que superar el segundo factor.
      mfaRequerido,
      factorMfa,
      verificacionResuelta,
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
      esRecepcion,
      puedeOperar,
      mfaRequerido,
      factorMfa,
      verificacionResuelta,
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
