import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import {
  actualizarPreferenciaAviso,
  consultarTurnoPublico,
  ErrorSitur,
  manifestarConsideraciones,
} from '../lib/rpc'
import { Modal } from '../components/ui'
import { CODIGO_TOKEN_EXPIRADO, CODIGO_TOKEN_INVALIDO } from '../lib/tipos'
import type { TurnoPublico } from '../lib/tipos'
import { supabase } from '../lib/supabase'
import {
  pedirPermiso,
  pushSoportado,
  estadoPermiso,
  type EstadoPermiso,
  registrarServiceWorker,
  suscribirAvisos,
  recordarTokenEnElServiceWorker,
} from '../lib/push'

/**
 * SITUR — Portal del ciudadano (RF-017, RF-018, RF-019, RF-028).
 *
 * Lo que este pantalla NO hace, y es lo importante:
 *
 *   * No pide cuenta, ni contraseña, ni aplicación, ni correo, ni teléfono.
 *   * No lee `turnos`: pide `get_turno_publico(token)` y ya está. Su rol
 *     `anon` no tiene privilegio sobre esa tabla.
 *   * No pide el permiso de notificaciones al entrar. Primero muestra el
 *     turno; solo después pregunta (DRS §5.2, paso 3). Pedirlo en frío suele
 *     ser rechazado y hunde la tasa de aceptación.
 */
export default function TurnoCiudadano() {
  const { token = '' } = useParams()
  const [turno, setTurno] = useState<TurnoPublico | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<{ titulo: string; detalle: string } | null>(null)
  /** RF-033: el titular manifiesta su consideracion y se opone. */
  const [oponiendo, setOponiendo] = useState(false)
  const [consideracion, setConsideracion] = useState('')
  const [errorConsideracion, setErrorConsideracion] = useState<string | null>(null)
  const [vivo, setVivo] = useState(false)
  /** Cambiando la preferencia del aviso (P14). */
  const [cambiandoPref, setCambiandoPref] = useState<number | null | undefined>(undefined)
  /** 0 = cerrado, 1 = "¿quieres aviso?", 2 = "precisión o rapidez". */
  const [pasoModalAviso, setPasoModalAviso] = useState<0 | 1 | 2>(0)
  /** El ciudadano ya cerró el modal alguna vez (eligió o dijo No). */
  const [yaDecidio, setYaDecidio] = useState(false)
  const [probandoAviso, setProbandoAviso] = useState(false)
  const [resultadoPrueba, setResultadoPrueba] = useState<string | null>(null)
  const [diagnostico, setDiagnostico] = useState<string | null>(null)
  const [probandoDiag, setProbandoDiag] = useState(false)
  /** Activando la suscripción push (paso 1 → paso 2). */
  const [activando, setActivando] = useState(false)
  /** Error visible del paso 1 (suscripción). */
  const [errorSuscripcion, setErrorSuscripcion] = useState<string | null>(null)
  /*
   * Lo que el navegador dice del permiso AHORA.
   *
   * Sin esto, el modal ofrecía «Sí, avísame» aunque el navegador tuviera los
   * avisos bloqueados para el sitio: el botón se pulsaba y no pasaba nada
   * visible, porque `requestPermission()` devuelve «denied» al instante y sin
   * abrir ningún diálogo. El ciudadano se quedaba mirando una pantalla que no
   * responde.
   */
  const [permiso, setPermiso] = useState<EstadoPermiso>('default')
  /** Error visible del paso 2 (guardar preferencia). */
  const [errorPref, setErrorPref] = useState<string | null>(null)
  /**
   * El ciudadano YA interactuó con el modal (eligió o cerró).
   *
   * Es un `useRef` y no un estado a propósito: no queremos re-renders por
   * esto. Solo sirve para que el `useEffect` que abre el modal no lo
   * vuelva a abrir aunque:
   *   - la BD tarde en reflejar la preferencia,
   *   - el `cargar()` de cada 10 s traiga datos viejos un instante,
   *   - Realtime dispare un evento a media transición.
   */
  const interactuoRef = useRef(false)

  const cargar = useCallback(async () => {
    try {
      const t = await consultarTurnoPublico(token)
      setTurno(t)
      setError(null)
    } catch (e) {
      const codigo = e instanceof ErrorSitur ? e.codigo : undefined
      if (codigo === CODIGO_TOKEN_EXPIRADO) {
        setError({
          titulo: 'Este código ya venció',
          detalle:
            'Los códigos de consulta tienen fecha de caducidad. Si su turno sigue en proceso, ' +
            'acuda a la ventanilla con su folio.',
        })
      } else if (codigo === CODIGO_TOKEN_INVALIDO) {
        setError({
          titulo: 'Código no válido',
          detalle: 'Revise el código QR que escaneó e inténtelo de nuevo.',
        })
      } else {
        setError({
          titulo: 'No se pudo consultar su turno',
          detalle: e instanceof Error ? e.message : 'Inténtelo de nuevo en unos segundos.',
        })
      }
    } finally {
      setCargando(false)
    }
  }, [token])

  useEffect(() => {
    void cargar()
  }, [cargar])

  // Actualización en vivo. Dos caminos, y el sistema no depende de ninguno:
  //
  //   1. Sondeo: `get_turno_publico` cada 10 s. Funciona siempre.
  //   2. Difusión: un canal Realtime por turno. El canal **no transporta
  //      datos del turno**: solo avisa de que algo cambió, y la pantalla
  //      vuelve a preguntar. Un token no recibe eventos de otro turno
  //      porque el canal se llama con su propio token (RF-019).
  useEffect(() => {
    if (!token) return
    // El sondeo es el respaldo, no el mecanismo principal: cuando el canal
    // de Realtime esta conectado, la difusion avisa del cambio y no hace
    // falta preguntar cada 10 s. Y con la pestana en segundo plano no se
    // pregunta en absoluto.
    let t: ReturnType<typeof setInterval> | null = null
    const arrancarSondeo = () => {
      if (t) return
      t = setInterval(() => {
        if (document.visibilityState === 'visible') void cargar()
      }, 10000)
    }
    const pararSondeo = () => {
      if (!t) return
      clearInterval(t)
      t = null
    }

    const canal = supabase.channel(`turno:${token}`)
    canal
      .on('broadcast', { event: 'turno-cambio' }, () => void cargar())
      .subscribe((estado) => {
        const conectado = estado === 'SUBSCRIBED'
        setVivo(conectado)
        if (conectado) pararSondeo()
        else arrancarSondeo()
      })
    arrancarSondeo()

    // Al volver a la pestana se comprueba de nuevo: puede haberse pasado algo
    // mientras estaba oculta.
    const alVolver = () => {
      if (document.visibilityState === 'visible') void cargar()
    }
    document.addEventListener('visibilitychange', alVolver)

    return () => {
      pararSondeo()
      document.removeEventListener('visibilitychange', alVolver)
      void supabase.removeChannel(canal)
    }
  }, [token, cargar])

  // Abrir el modal de aviso al cargar el turno, si aún no se ha decidido.
  //
  // El guard `pasoModalAviso !== 0` y la dep `pasoModalAviso` son lo que
  // evita el bug de «el modal se reinicia solo»:
  //
  //   · `turno` cambia cada 10 s (sondeo) y con cada evento Realtime.
  //   · Cada cambio re-ejecutaba el efecto, que programaba
  //     `setPasoModalAviso(1)` a +800 ms.
  //   · Si el ciudadano ya estaba en el paso 2 leyendo las opciones, el
  //     timer lo devolvía al paso 1 a media lectura.
  //
  // Con el guard, el efecto solo puede disparar la apertura cuando el modal
  // está cerrado (paso 0). Si ya está abierto, no toca nada.
  useEffect(() => {
    // Blindaje local: si el ciudadano ya interactuó, no volver a abrir.
    if (interactuoRef.current) return
    if (pasoModalAviso !== 0) return
    if (!turno) return
    if (turno.estado !== 'WAITING') return
    if (turno.preferencia_aviso_minutos !== null) return
    if (localStorage.getItem(`situr_pref_vista_${token}`)) return
    // Pequeño retraso para que el ciudadano vea primero su turno.
    const t = window.setTimeout(() => {
      // Se vuelve a chequear dentro del timer: si el ciudadano interactuó
      // durante los 800 ms (por ejemplo, cerró el modal), no abrir.
      if (interactuoRef.current) return
      setPermiso(estadoPermiso())
      setPasoModalAviso(1)
    }, 800)
    return () => window.clearTimeout(t)
  }, [turno, token, pasoModalAviso])

  // El Service Worker se registra desde el principio (no requiere permiso),
  // para que la suscripción sea instantánea cuando el ciudadano acepte.
  useEffect(() => {
    void registrarServiceWorker()
  }, [])

  /*
   * El Service Worker guarda el token del turno (RF-028). Lo necesita para
   * saber adónde abrir el aviso, porque el token NO puede viajar en el
   * aviso: el DRS §5.2 lo prohíbe (el aviso pasa por el proveedor de push,
   * que es un tercero). Se le pasa en cuanto se abre el portal, no solo
   * cuando el ciudadano acepta el aviso, para que un token regenerado
   * (RF-007) sustituya al anterior.
   */
  useEffect(() => {
    void recordarTokenEnElServiceWorker(token)
  }, [token])

  /** DRS §5.2, paso 3: el permiso se pide DESPUÉS de mostrar el turno. */

  /**
   * RF-033: el titular se opone al tratamiento. Se hace con su token, que
   * es lo unico que tiene. El turno se cancela con constancia de que fue
   * el titular, y el operador lo ve antes de llamar a nadie.
   */
  async function oponer() {
    setOponiendo(true)
    setErrorConsideracion(null)
    try {
      await manifestarConsideraciones(token, consideracion)
      setConsideracion('')
      await cargar()
    } catch (e) {
      setErrorConsideracion(
        e instanceof ErrorSitur ? e.message : 'No se pudo registrar su consideración.',
      )
    } finally {
      setOponiendo(false)
    }
  }

  /** Cerrar el modal sin elegir (se guarda en localStorage para no repetir). */
  function cerrarModalAviso() {
    interactuoRef.current = true
    localStorage.setItem(`situr_pref_vista_${token}`, '1')
    setYaDecidio(true)
    setPasoModalAviso(0)
  }

  /**
   * Paso 1: activar la suscripción push y pasar al paso 2.
   */
  async function activarAviso() {
    setErrorSuscripcion(null)
    if (!pushSoportado()) {
      setErrorSuscripcion(
        'Este navegador no admite notificaciones. Puede intentarlo desde otro dispositivo.',
      )
      return
    }
    setActivando(true)
    try {
      const concedido = await pedirPermiso()
      if (!concedido) {
        setPermiso(estadoPermiso())
        setErrorSuscripcion(
          estadoPermiso() === 'denied'
            ? 'Los avisos están bloqueados para este sitio. Ábralos en los ajustes del navegador (Notificaciones → permitir) y vuelva a intentarlo.'
            : 'No se pudo pedir el permiso de notificaciones. Inténtelo desde el navegador del móvil, no desde una vista incrustada.',
        )
        return
      }
      setPermiso('granted')
      const ok = await suscribirAvisos(token)
      if (!ok) {
        setErrorSuscripcion(
          'No se pudo activar el aviso. Intente de nuevo en unos segundos.',
        )
        return
      }
      setPasoModalAviso(2)
    } finally {
      setActivando(false)
    }
  }

  async function comprobarAviso() {
    setProbandoDiag(true)
    setDiagnostico(null)
    try {
      const sw = await navigator.serviceWorker.getRegistration('/')
      const sub = sw ? await sw.pushManager.getSubscription() : null
      const partes = []
      partes.push(`Permiso: ${'Notification' in window ? Notification.permission : 'sin Notification'}`)
      partes.push(`Service Worker: ${sw ? (sw.active ? 'activo' : 'no activo') : 'no registrado'}`)
      partes.push(`Suscripción: ${sub ? 'guardada en el navegador' : 'no hay'}`)
      if (sub) {
        try {
          const r = await fetch(`/api/probar-aviso?token=${encodeURIComponent(token)}`)
          const d = await r.json()
          partes.push(`Servidor: ${d.ok ? 'enviado (debe sonar)' : d.motivo}`)
        } catch {
          partes.push('Servidor: no respondió')
        }
      }
      setDiagnostico(partes.join(' · '))
    } catch (e) {
      setDiagnostico('No se pudo comprobar: ' + (e instanceof Error ? e.message : 'desconocido'))
    } finally {
      setProbandoDiag(false)
    }
  }

  async function probarAviso() {
    setProbandoAviso(true)
    setResultadoPrueba(null)
    try {
      const r = await fetch(`/api/probar-aviso?token=${encodeURIComponent(token)}`)
      const d = await r.json()
      setResultadoPrueba(d.ok
        ? 'Se envió un aviso de prueba. Debe sonar en este móvil en unos segundos.'
        : `No se pudo: ${d.motivo}`)
    } catch {
      setResultadoPrueba('No se pudo contactar con el servidor. Revise la conexión.')
    } finally {
      setProbandoAviso(false)
    }
  }

  /** Reabrir el modal para que el ciudadano que dijo No pueda cambiar de opinión. */
  function reabrirModalAviso() {
    setErrorSuscripcion(null)
    setErrorPref(null)
    setPermiso(estadoPermiso())
    setPasoModalAviso(1)
  }

  /** Elegir una preferencia desde el modal (paso 2). */
  async function elegirPreferencia(minutos: number) {
    setCambiandoPref(minutos)
    try {
      await actualizarPreferenciaAviso(token, minutos)
      // Marcar el ref ANTES de cerrar el modal: si el `cargar()` de cada
      // 10 s corre en paralelo y trae datos viejos, el `useEffect` no
      // reabrirá el modal.
      interactuoRef.current = true
      localStorage.setItem(`situr_pref_vista_${token}`, '1')
      // Actualizar el turno en memoria sin volver a llamar a `cargar()`:
      // así el estado `turno` refleja la nueva preferencia de inmediato,
      // sin depender del endpoint.
      setTurno((prev) =>
        prev ? { ...prev, preferencia_aviso_minutos: minutos } : prev,
      )
      setYaDecidio(true)
      setPasoModalAviso(0)
    } catch {
      // Si la BD rechaza el cambio, el modal se queda abierto para
      // reintentar. No marcamos `interactuoRef` ni `localStorage`.
    } finally {
      setCambiandoPref(undefined)
    }
  }

  /**
   * Cambiar la preferencia del aviso (P14).
   * Solo mientras el turno está en WAITING.
   */

  /** Retirar el consentimiento (P12). Un permiso que no se puede quitar
   *  no es consentimiento. */

  // -------------------------------------------------------------- pantalla

  if (cargando) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gris-50">
        <p className="text-sm text-gris-500">Consultando su turno…</p>
      </div>
    )
  }

  if (error || !turno) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gris-50 p-4">
        <div className="tarjeta w-full max-w-md p-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ambar-50 text-ambar-600">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <h1 className="text-lg font-bold text-navy-800">{error?.titulo}</h1>
          <p className="mt-2 text-sm text-gris-700">{error?.detalle}</p>
          <button type="button" onClick={() => void cargar()} className="boton-secundario mt-5">
            Reintentar
          </button>
        </div>
      </div>
    )
  }

  const estilo = estiloEstado(turno.estado)

  return (
    <div className="min-h-screen bg-gris-50">
      {/*
        LA CABECERA, con la marca y la hora.

        Oscura y breve a propósito: el portal se lee en el teléfono, a
        menudo en la calle y con la pantalla al sol. Un fondo oscuro entero
        en un móvil es luz gastada y texto ilegible; la ficha de abajo va
        en blanco, que es donde está la información que importa.
      */}
      <header className="bg-navy-800 px-3 py-2.5 text-white sm:px-4 sm:py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight">
              Sistema de toma de turnos
            </p>
            <p className="truncate text-[11px] text-white/60">
              Dirección de Catastro · Durango
            </p>
          </div>
          <p className="hidden text-right text-xs text-white/70 sm:block">
            <span className="block font-semibold text-white">
              {new Intl.DateTimeFormat('es-MX', {
                timeZone: 'America/Mazatlan',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date())}
            </span>
            {new Intl.DateTimeFormat('es-MX', {
              timeZone: 'America/Mazatlan',
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }).format(new Date())}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-3 pb-8 sm:p-4 sm:pb-10">
        <div className="grid min-w-0 gap-4 md:mx-auto md:max-w-2xl lg:mx-0 lg:max-w-none lg:grid-cols-[minmax(0,1fr)_300px]">
        {/*
          La columna de la ficha: la ficha del turno, los avisos y los dos
          desplegables (oponerse y aviso de privacidad).
        */}
        <div className="min-w-0 space-y-4">
        {/* La ficha */}
        <div className="tarjeta overflow-hidden">
          {/*
            `role="status"` con `aria-live="polite"`: el estado del turno
            cambia solo (de "en espera" a "fue llamado"), y sin esto un
            usuario de lector de pantalla no se enteraría de que lo están
            llamando. Es WCAG 4.1.3 (Status Messages, AA) y es LA función del
            portal: avisar de que toca.
          */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="px-6 py-6 text-center"
          >
            <span
              className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${estilo.fondo}`}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {turno.estado === 'WAITING' ? (
                  /* esperando: un reloj */
                  <>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </>
                ) : turno.estado === 'CANCELLED' || turno.estado === 'SKIPPED' ? (
                  /* retirado: una cruz */
                  <>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </>
                ) : (
                  /* llamado o atendido: un visto bueno */
                  <path d="M20 6 9 17l-5-5" />
                )}
              </svg>
            </span>
            <p className="text-xs font-semibold uppercase tracking-widest text-gris-500">
              Su turno
            </p>
            {/* El código, en su caja: es lo que el ciudadano viene a ver. */}
            <div className={`mx-auto mt-2 max-w-xs rounded-xl px-6 py-4 ${estilo.fondo}`}>
              <h1 className={`break-words text-4xl font-black leading-none tracking-tight sm:text-5xl ${estilo.texto}`}>
                {turno.codigo_turno}
              </h1>
              <p className={`mt-1.5 break-words text-sm font-semibold ${estilo.texto}`}>
                {turno.denominacion_tramite}
              </p>
            </div>
            <p className="mx-auto mt-2 max-w-[17rem] text-[10px] leading-relaxed text-gris-500 sm:max-w-xs">
              No comparta este código con nadie. Es su credencial para
              consultar el turno.
            </p>
            <p className={`mt-3 break-words text-sm font-semibold ${estilo.texto}`}>{turno.mensaje}</p>
          </div>

          <dl className="space-y-1 border-t border-gris-100 px-5 py-4">
            <Dato
              etiqueta="Estado"
              valor={etiquetaEstado(turno.estado)}
              icono="info"
              destacado={turno.estado === 'CALLED'}
            />
            {turno.estado === 'WAITING' && (
              <>
                <Dato
                  etiqueta="Posición en la cola"
                  valor={`${turno.posicion}`}
                  icono="lista"
                />
                <Dato
                  etiqueta="Personas adelante"
                  valor={`${turno.personas_delante}`}
                  icono="personas"
                />
              </>
            )}
            {turno.modulo && (
              <Dato etiqueta="Módulo" valor={turno.modulo} icono="modulo" />
            )}
            {turno.token_primer_acceso === null && (
              <Dato
                etiqueta="Consulta"
                valor="Primera vez que abre este enlace"
                icono="info"
              />
            )}
            {turno.llamado_en && (
              <Dato
                etiqueta="Llamado"
                valor={formatearHora(turno.llamado_en)}
                icono="reloj"
              />
            )}
          </dl>
        </div>

        {/* Preferencia de aviso (P14): modal en dos pasos */}
        {pasoModalAviso === 1 && (
          <Modal
            titulo="¿Le avisamos cuando se acerque su turno?"
            onCerrar={cerrarModalAviso}
            ancho="max-w-md"
          >
            <div className="space-y-4 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-azul-50 text-azul-500">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                </svg>
              </span>
              <p className="text-sm text-gris-700">
                Le enviaremos una notificación al móvil cuando su turno esté
                próximo, aunque tenga esta pestaña cerrada. No guardamos su
                nombre ni su teléfono.
              </p>
              {errorSuscripcion && (
                <p
                  role="alert"
                  className="rounded-lg border border-rojo-500/30 bg-rojo-50 px-3 py-2 text-xs font-semibold text-rojo-600"
                >
                  {errorSuscripcion}
                </p>
              )}

              {/*
                El navegador manda. Si los avisos están bloqueados —o el
                navegador no los admite— no se ofrece un botón que no va a
                hacer nada: se explica cómo desbloquearlos y se deja cerrar.
              */}
              {permiso === 'denied' && (
                <p className="rounded-lg border border-ambar-500/30 bg-ambar-50 px-3 py-2 text-xs font-semibold text-ambar-600">
                  Este navegador tiene los avisos <strong>bloqueados</strong> para
                  este sitio. Para activarlos: candado o «Aa» en la barra de
                  direcciones → Notificaciones → Permitir. Después, recargue esta
                  página.
                </p>
              )}

              {!pushSoportado() && (
                <p className="rounded-lg border border-ambar-500/30 bg-ambar-50 px-3 py-2 text-xs font-semibold text-ambar-600">
                  Este navegador no admite avisos push. En <strong>iPhone</strong>{' '}
                  hay que añadir la página a la pantalla de inicio (Compartir →
                  «Añadir a pantalla de inicio») y abrirla desde ahí.
                </p>
              )}

              <div className="flex flex-col gap-2">
                {permiso === 'denied' || !pushSoportado() ? (
                  <button
                    type="button"
                    onClick={cerrarModalAviso}
                    className="boton-primario w-full py-3"
                  >
                    Entendido
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void activarAviso()}
                      disabled={activando}
                      className="boton-primario w-full py-3 disabled:opacity-60"
                    >
                      {activando ? 'Activando…' : 'Sí, avísame'}
                    </button>
                    <button
                      type="button"
                      onClick={cerrarModalAviso}
                      className="boton-secundario w-full py-3"
                    >
                      No, gracias
                    </button>
                  </>
                )}
              </div>
            </div>
          </Modal>
        )}

        {pasoModalAviso === 2 && (
          <Modal
            titulo="¿Cómo prefiere el aviso?"
            onCerrar={cerrarModalAviso}
            ancho="max-w-md"
          >
            <div className="space-y-3">
              <p className="text-sm text-gris-700">
                Elija cómo quiere que le avisemos. Podrá cambiarlo después.
              </p>
              {errorPref && (
                <p
                  role="alert"
                  className="rounded-lg border border-rojo-500/30 bg-rojo-50 px-3 py-2 text-xs font-semibold text-rojo-600"
                >
                  {errorPref}
                </p>
              )}
              <button
                type="button"
                onClick={() => void elegirPreferencia(15)}
                disabled={cambiandoPref !== undefined}
                className="flex w-full items-start gap-3 rounded-xl border border-gris-200 bg-white p-4 text-left transition-colors hover:border-azul-500 hover:bg-azul-50 disabled:opacity-60"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-azul-50 text-azul-500">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-navy-800">
                    {cambiandoPref === 15 ? 'Guardando…' : 'Con tiempo · 15 min'}
                  </span>
                  <span className="mt-0.5 block text-xs text-gris-700">
                    Ideal si va a alejarse. Le avisamos 15 minutos antes.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void elegirPreferencia(5)}
                disabled={cambiandoPref !== undefined}
                className="flex w-full items-start gap-3 rounded-xl border border-gris-200 bg-white p-4 text-left transition-colors hover:border-azul-500 hover:bg-azul-50 disabled:opacity-60"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-azul-50 text-azul-500">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-navy-800">
                    {cambiandoPref === 5 ? 'Guardando…' : 'Rápido · 5 min'}
                  </span>
                  <span className="mt-0.5 block text-xs text-gris-700">
                    Ideal si está cerca. Le avisamos 5 minutos antes.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={cerrarModalAviso}
                className="w-full text-center text-xs text-gris-500 underline"
              >
                Decidir después
              </button>
            </div>
          </Modal>
        )}

        {turno.estado === 'WAITING' && turno.preferencia_aviso_minutos !== null && (
          <div className="mt-3 flex min-w-0 justify-center">
            <button
              type="button"
              onClick={() => setPasoModalAviso(2)}
              className="text-xs text-gris-500 underline hover:text-azul-600"
            >
              Cambiar preferencia de aviso
            </button>
          </div>
        )}

        {turno.estado === 'WAITING' && turno.preferencia_aviso_minutos === null && yaDecidio && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={reabrirModalAviso}
              className="boton-primario px-3 py-2 text-xs sm:px-4 sm:text-sm"
            >
              🔔 Quiero que me avisen
            </button>
          </div>
        )}



        <p className="mt-4 text-center text-[11px] text-gris-700">
          {vivo ? 'Actualización en vivo activa' : 'Actualización automática'} · No
          requiere cuenta ni datos personales
        </p>

        {/*
          DIAGNÓSTICO DEL AVISO.

          El aviso depende de dos cosas que el ciudadano no ve: que el
          Service Worker esté activo y que el navegador permita notificar.
          Este botón manda un aviso de prueba a este turno y dice en
          pantalla lo que pasó. Si dice «enviado» y no sonó, el bloqueo
          está en el sistema operativo, no en la app.
        */}
        {pushSoportado() && (
          <div className="mt-3 flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => void probarAviso()}
              disabled={probandoAviso}
              className="text-xs text-gris-500 underline hover:text-azul-600 disabled:opacity-60"
            >
              {probandoAviso ? 'Enviando…' : 'Probar el aviso'}
            </button>
            {resultadoPrueba && (
              <p className="max-w-xs text-center text-[11px] text-gris-700">
                {resultadoPrueba}
              </p>
            )}

            <button
              type="button"
              onClick={() => void comprobarAviso()}
              disabled={probandoDiag}
              className="text-[11px] text-gris-400 underline hover:text-azul-600 disabled:opacity-60"
            >
              {probandoDiag ? 'Comprobando…' : 'Comprobar el aviso'}
            </button>
            {diagnostico && (
              <p className="max-w-xs text-center text-[11px] text-gris-500">
                {diagnostico}
              </p>
            )}
          </div>
        )}

        {/*
          EL DERECHO A OPONERSE (RF-033, LFPDPPP art. 21).
          Toda persona titular puede oponerse al tratamiento de sus datos por
          causa legitima. Como el ciudadano no deja datos de identidad, la via
          para ejercerlo es su propio token: lo escribe aqui y su turno se
          cancela con constancia de que fue el, no la ventanilla.
        */}
        {(turno.estado === 'WAITING' || turno.estado === 'CALLED') && (
          <Acordeon titulo="No quiero que se atienda mi turno">
              <div className="space-y-2">
                <p className="text-xs leading-relaxed text-gris-700">
                  Puede oponerse a que se atienda su turno. Se registra su
                  consideracion y el turno se cancela. Si cree que hubo un
                  error, acuda a la ventanilla con su codigo.
                </p>
                <textarea
                  className="campo text-sm"
                  rows={2}
                  maxLength={300}
                  placeholder="Escriba su consideracion (hasta 300 caracteres)"
                  value={consideracion}
                  onChange={(e) => setConsideracion(e.target.value)}
                />
                {errorConsideracion && (
                  <p className="text-xs font-semibold text-rojo-600">
                    {errorConsideracion}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void oponer()}
                  disabled={oponiendo || !consideracion.trim()}
                  className="boton-secundario px-3 py-1.5 text-xs"
                >
                  {oponiendo ? 'Registrando…' : 'Registrar mi consideración'}
                </button>
              </div>
            </Acordeon>
        )}

        {/*
          AVISO DE PRIVACIDAD (RF-027).

          El DRS exige la validación jurídica de protección de datos ANTES de
          producción, con aviso de privacidad, finalidad, conservación y
          control de derechos ARCO. Este es el punto de contacto del ciudadano
          con el sistema: es donde el aviso tiene que estar, y no puede ser un
          PDF que nadie abre.

          Lo que sí se puede afirmar con honestidad, porque el sistema lo
          cumple de verdad:
            · No se pide ningun dato de identidad: ni nombre, ni correo, ni
              telefono, ni direccion. El turno es un codigo.
            · El unico identificador es un token aleatorio de 256 bits, y deja
              de validar cuando caduca.
            · Lo que se guarda es el estado del turno, con fecha y hora.
          Y lo que hay que decir con cuidado: si se suscribe a los avisos, el
          navegador entrega una direccion de aviso que pertenece a su
          proveedor de correo, y eso es un tercero.
        */}
        <Acordeon titulo="Aviso de privacidad">
          <div className="space-y-2 text-xs leading-relaxed text-gris-700">
            <p>
              <strong>Que se guarda.</strong> El codigo de su turno, su estado y
              las horas en que se emitio, se llamo y se atendio.{' '}
              <strong>No se pide ningun dato de identidad</strong>: ni nombre, ni
              correo, ni telefono, ni direccion.
            </p>
            <p>
              <strong>Para que.</strong> Solo para que usted consulte y atienda
              su turno. Sus datos no se usan con ninguna otra finalidad.
            </p>
            <p>
              <strong>Cuanto tiempo.</strong> El codigo de consulta deja de
              funcionar al caducar; los datos del turno se conservan para el
              registro de la atencion, y los avisos a los que se suscriba se
              borran en cuanto su turno termina.
            </p>
            <p>
              <strong>Terceros.</strong> Si activa los avisos, su navegador
              entrega una direccion de aviso a su proveedor de correo (Google,
              Apple u otro); esa direccion se guarda hasta que termina su
              turno. El sistema en si no comparte datos con terceros.
            </p>
            <p>
              <strong>Sus derechos.</strong> Puede pedir el acceso, la
              correccion o la eliminacion de sus datos, y revocar los avisos
              cuando quiera, en la ventanilla de la Direccion de Catastro.
            </p>
          </div>
        </Acordeon>
        <Acordeon titulo="¿Cerró esta ventana?">
          <div className="space-y-2 text-xs leading-relaxed text-gris-700">
            <p>
              Su turno <strong>sigue en la fila</strong> aunque cierre esta
              ventana. Para volver a consultarlo:
            </p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>
                <strong>Escanee de nuevo el código QR</strong> de su boleto.
              </li>
              <li>
                <strong>Busque esta página en el historial</strong> de su
                navegador (suele estar en el menú de los tres puntos, en
                «Historial»).
              </li>
              <li>
                <strong>Acuda a la ventanilla</strong> con su código impreso:
                el operador puede reimprimir el QR.
              </li>
            </ol>
            <p className="text-gris-500">
              Si no encuentra su boleto ni recuerda el código, el operador
              puede ayudarle en ventanilla.
            </p>
          </div>
        </Acordeon>

        </div>

        {/*
          EL RIEL.

          En la referencia de diseño, este riel muestra «Próximos turnos» con
          los códigos de los demás ciudadanos. **Aquí no**: el ciudadano de
          SITUR es anónimo y el sistema no le enseña los turnos de nadie más
          (RF-019, y la nota de protección de datos). Se mantiene la
          FORMA del riel —que es lo que aporta la referencia— y se cambia el
          contenido por los números del propio turno.
        */}
        <aside className="min-w-0 space-y-4">
          {turno.estado === 'WAITING' && (
            <div className="rounded-2xl bg-azul-600 p-4 text-white sm:p-5">
              <h2 className="text-xs font-bold uppercase tracking-widest text-white/70">
                Tu turno en números
              </h2>
              <div className="mt-3 space-y-0">
                <div className="flex min-w-0 items-center justify-between gap-2 border-b border-white/20 py-2.5">
                  <span className="truncate text-sm text-white/85">Posición</span>
                  <b className="shrink-0 text-lg">{turno.posicion}</b>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 py-2.5">
                  <span className="truncate text-sm text-white/85">Personas delante</span>
                  <b className="shrink-0 text-lg">{turno.personas_delante}</b>
                </div>
              </div>
              <p className="mt-3 break-words text-xs leading-relaxed text-white/70">
                Solo ve los números de <strong className="text-white">su</strong>{' '}
                turno. El sistema no muestra los turnos de los demás ciudadanos.
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-gris-200 bg-white p-4 sm:p-5">
            <h2 className="text-xs font-bold uppercase tracking-widest text-gris-500">
              Sin cuenta, sin datos
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gris-700">
              El código QR de su boleto es su única credencial. No se pide
              nombre, correo ni teléfono, y el código deja de servir cuando el
              turno se cierra.
            </p>
          </div>
        </aside>
        </div>
      </main>
    </div>
  )
}

/**
 * Una fila de datos, con su icono en un círculo.
 *
 * El icono no es decorativo: dice de un vistazo de qué campo se trata
 * (un reloj es el tiempo, un calendario es la fecha, una lista son los
 * datos del turno) y evita tener que leer la etiqueta.
 */
/**
 * Acordeón animado: grid-template-rows 0fr → 1fr (transición real, sin JS).
 */
function Acordeon({
  titulo,
  children,
}: {
  titulo: string
  children: ReactNode
}) {
  const [abierto, setAbierto] = useState(false)
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-gris-200 bg-white">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-left text-xs font-semibold text-gris-700 transition-colors hover:bg-gris-50 sm:px-4 sm:py-3 sm:text-sm"
      >
        <span className="min-w-0 break-words">{titulo}</span>
        <svg
          className={`h-4 w-4 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none ${
            abierto ? 'rotate-180' : ''
          }`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          abierto ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-gris-100 px-3 py-2.5 sm:px-4 sm:py-3">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

function Dato({ etiqueta, valor, icono, destacado }: {
  etiqueta: string
  valor: string
  icono?: 'reloj' | 'calendario' | 'lista' | 'modulo' | 'personas' | 'info'
  destacado?: boolean
}) {
  return (
    /*
      El icono va DENTRO del <dt>: un <div> dentro de un <dl> solo puede
      contener <dt> y <dd> (HTML), y axe lo comprueba (regla
      `definition-list`).
    */
    <div className="flex min-w-0 items-center gap-3 px-1 py-2">
      <dt className="flex min-w-0 flex-1 items-center gap-3 text-sm text-gris-700">
        {icono && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-azul-50 text-azul-500">
            <IconoDato nombre={icono} />
          </span>
        )}
        <span className="min-w-0 break-words">{etiqueta}</span>
      </dt>
      <dd
        className={`shrink-0 text-sm font-bold ${
          destacado ? 'text-ambar-600' : 'text-navy-800'
        }`}
      >
        {valor}
      </dd>
    </div>
  )
}

/** Los iconos de las filas de datos, en línea (24x24, trazo 2). */
function IconoDato({ nombre }: { nombre: 'reloj' | 'calendario' | 'lista' | 'modulo' | 'personas' | 'info' }) {
  const trazos: Record<typeof nombre, ReactNode> = {
    reloj: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    calendario: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 11h18" />
      </>
    ),
    lista: <path d="M4 7h16M4 12h10M4 17h7" />,
    modulo: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    personas: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20a6 6 0 0 1 12 0" />
        <path d="M16 5.5a3 3 0 0 1 0 5.6M18 20a6 6 0 0 0-2-4.5" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {trazos[nombre]}
    </svg>
  )
}

function etiquetaEstado(estado: TurnoPublico['estado']): string {
  switch (estado) {
    case 'WAITING':
      return 'En espera'
    case 'CALLED':
      return 'Llamado'
    case 'SERVING':
      return 'En atención'
    case 'COMPLETED':
      return 'Atendido'
    case 'CANCELLED':
      return 'Cancelado'
    case 'SKIPPED':
      return 'Omitido'
  }
}

function estiloEstado(estado: TurnoPublico['estado']): { fondo: string; texto: string } {
  switch (estado) {
    case 'CALLED':
      return { fondo: 'bg-ambar-50', texto: 'text-ambar-600' }
    case 'SERVING':
      return { fondo: 'bg-verde-50', texto: 'text-verde-600' }
    case 'COMPLETED':
      return { fondo: 'bg-gris-100', texto: 'text-gris-700' }
    case 'CANCELLED':
    case 'SKIPPED':
      return { fondo: 'bg-rojo-50', texto: 'text-rojo-600' }
    default:
      /* En espera: azul claro, como la caja del código en la referencia.
         El estado en sí lo dice el texto de al lado. */
      return { fondo: 'bg-azul-50', texto: 'text-navy-800' }
  }
}

function formatearHora(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mazatlan',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}
