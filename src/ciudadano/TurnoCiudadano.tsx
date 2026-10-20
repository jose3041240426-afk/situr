import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { consultarTurnoPublico, ErrorSitur, manifestarConsideraciones } from '../lib/rpc'
import { CODIGO_TOKEN_EXPIRADO, CODIGO_TOKEN_INVALIDO } from '../lib/tipos'
import type { TurnoPublico } from '../lib/tipos'
import { supabase } from '../lib/supabase'
import {
  pedirPermiso,
  pushSoportado,
  registrarServiceWorker,
  cancelarAvisos,
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
  const [preguntando, setPreguntando] = useState(false)
  const [suscrito, setSuscrito] = useState(false)
  const [rechazado, setRechazado] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  /** RF-033: el titular manifiesta su consideracion y se opone. */
  const [oponiendo, setOponiendo] = useState(false)
  const [consideracion, setConsideracion] = useState('')
  const [errorConsideracion, setErrorConsideracion] = useState<string | null>(null)
  const [vivo, setVivo] = useState(false)

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
  async function preguntar() {
    setPreguntando(true)
    try {
      const ok = await pedirPermiso()
      if (!ok) {
        setRechazado(true)
        return
      }
      const exito = await suscribirAvisos(token)
      setSuscrito(exito)
      if (!exito) setRechazado(true)
    } finally {
      setPreguntando(false)
    }
  }

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

  /** Retirar el consentimiento (P12). Un permiso que no se puede quitar
   *  no es consentimiento. */
  async function dejarDeAvisar() {
    setCancelando(true)
    try {
      await cancelarAvisos(token)
      setSuscrito(false)
    } finally {
      setCancelando(false)
    }
  }

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
      <header className="bg-navy-800 px-4 py-3 text-center">
        <p className="text-sm font-bold text-white">SITUR</p>
        <p className="text-[11px] text-gris-200">Dirección de Catastro · Durango</p>
      </header>

      <main className="mx-auto max-w-lg p-4 pb-10">
        {/* Código del turno */}
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
            className={`px-6 py-6 text-center ${estilo.fondo}`}
          >
            <p className="text-xs font-semibold uppercase tracking-widest opacity-70">
              Su turno
            </p>
            <h1 className={`mt-1 text-5xl font-black tracking-tight ${estilo.texto}`}>
              {turno.codigo_turno}
            </h1>
            <p className={`mt-2 text-sm font-semibold ${estilo.texto}`}>{turno.mensaje}</p>
          </div>

          <dl className="divide-y divide-gris-100">
            <Dato etiqueta="Trámite" valor={turno.denominacion_tramite} />
            <Dato
              etiqueta="Estado"
              valor={etiquetaEstado(turno.estado)}
              destacado={turno.estado === 'CALLED'}
            />
            {turno.estado === 'WAITING' && (
              <>
                <Dato etiqueta="Posición en la cola" valor={`${turno.posicion}`} />
                <Dato
                  etiqueta="Personas adelante"
                  valor={`${turno.personas_delante}`}
                />
              </>
            )}
            {turno.modulo && <Dato etiqueta="Módulo" valor={turno.modulo} />}
            {turno.tiempo_estimado_minutos != null && (
              <Dato
                etiqueta="Tiempo estimado"
                valor={`${turno.tiempo_estimado_minutos} min`}
              />
            )}
            <Dato etiqueta="Emitido" valor={formatearHora(turno.creado_en)} />
            {turno.llamado_en && (
              <Dato etiqueta="Llamado" valor={formatearHora(turno.llamado_en)} />
            )}
          </dl>
        </div>

        {/* Avisos push (RF-028) */}
        {turno.estado === 'WAITING' || turno.estado === 'CALLED' ? (
          <div className="mt-4">
            {suscrito ? (
              <div className="rounded-xl border border-verde-500/30 bg-verde-50 px-4 py-3 text-sm text-verde-600">
                <p className="font-bold">Le avisaremos cuando se acerque su turno</p>
                <p className="mt-0.5 text-xs">
                  Recibirá el aviso aunque cierre esta pestaña.
                </p>
                {/*
                  EL CONSENTIMIENTO SE PUEDE RETIRAR (P12). Un permiso que no
                  se puede quitar no es consentimiento: la RPC
                  `eliminar_suscripcion_push` ya existía, pero no había forma
                  de llegar a ella desde aquí.
                */}
                <button
                  type="button"
                  onClick={() => void dejarDeAvisar()}
                  disabled={cancelando}
                  className="mt-2 text-xs font-semibold text-verde-600 underline underline-offset-2 hover:text-verde-500"
                >
                  {cancelando ? 'Cancelando…' : 'Dejar de avisarme'}
                </button>
              </div>
            ) : rechazado ? (
              <div className="rounded-xl border border-gris-200 bg-white px-4 py-3 text-sm text-gris-700">
                <p className="font-semibold text-gris-700">
                  Sin problema: su turno se actualiza solo en esta pantalla
                </p>
                <p className="mt-0.5 text-xs">
                  Si cambió de opinión, puede recargar la página y volver a intentarlo.
                </p>
              </div>
            ) : pushSoportado() ? (
              <div className="tarjeta p-4">
                <p className="text-sm font-bold text-navy-800">
                  ¿Quiere que le avisemos cuando se acerque su turno?
                </p>
                <p className="mt-1 text-xs text-gris-700">
                  Le llega al navegador aunque tenga esta pestaña cerrada. Para
                  mandárselo, su navegador guarda una dirección de aviso que
                  pertenece a su proveedor de correo (en la mayoría de los
                  casos, Google). No guardamos su nombre, su correo ni su
                  teléfono, y puede cancelar cuando quiera.
                </p>
                <button
                  type="button"
                  onClick={() => void preguntar()}
                  disabled={preguntando}
                  className="boton-primario mt-3 w-full"
                >
                  {preguntando ? 'Activando…' : 'Sí, avisarme'}
                </button>
              </div>
            ) : (
              <div className="rounded-xl border border-gris-200 bg-white px-4 py-3 text-sm text-gris-700">
                Este navegador no admite avisos. Deje la página abierta: se
                actualiza sola.
              </div>
            )}
          </div>
        ) : null}

        <p className="mt-4 text-center text-[11px] text-gris-700">
          {vivo ? 'Actualización en vivo activa' : 'Actualización automática'} · No
          requiere cuenta ni datos personales
        </p>

        {/*
          EL DERECHO A OPONERSE (RF-033, LFPDPPP art. 21).
          Toda persona titular puede oponerse al tratamiento de sus datos por
          causa legitima. Como el ciudadano no deja datos de identidad, la via
          para ejercerlo es su propio token: lo escribe aqui y su turno se
          cancela con constancia de que fue el, no la ventanilla.
        */}
        {(turno.estado === 'WAITING' || turno.estado === 'CALLED') && (
          <div className="mt-4 rounded-xl border border-gris-100 bg-white px-4 py-3">
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-gris-700">
                No quiero que se atienda mi turno
              </summary>
              <div className="mt-3 space-y-2">
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
            </details>
          </div>
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
        <details className="mt-4 rounded-xl border border-gris-100 bg-white px-4 py-3 text-left">
          <summary className="cursor-pointer text-xs font-semibold text-gris-700">
            Aviso de privacidad
          </summary>
          <div className="mt-2 space-y-2 text-xs leading-relaxed text-gris-700">
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
        </details>
      </main>
    </div>
  )
}

function Dato({ etiqueta, valor, destacado }: {
  etiqueta: string
  valor: string
  destacado?: boolean
}) {
  return (
    <div className="flex items-center justify-between px-6 py-3">
      <dt className="text-sm text-gris-700">{etiqueta}</dt>
      <dd
        className={`text-sm font-bold ${
          destacado ? 'text-ambar-600' : 'text-navy-800'
        }`}
      >
        {valor}
      </dd>
    </div>
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
      return { fondo: 'bg-gris-100', texto: 'text-navy-800' }
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
