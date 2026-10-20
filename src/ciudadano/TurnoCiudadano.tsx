import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
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
      {/*
        LA CABECERA, con la marca y la hora.

        Oscura y breve a propósito: el portal se lee en el teléfono, a
        menudo en la calle y con la pantalla al sol. Un fondo oscuro entero
        en un móvil es luz gastada y texto ilegible; la ficha de abajo va
        en blanco, que es donde está la información que importa.
      */}
      <header className="bg-navy-800 px-4 py-3 text-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 7.2A2.2 2.2 0 0 1 6.2 5H20v5.4a2.6 2.6 0 0 0 0 3.2V19H6.2A2.2 2.2 0 0 1 4 16.8z" />
                <path d="M15.6 5.6v12.8" strokeDasharray="2 2.4" />
                <path d="M7.4 10.2h5M7.4 13.4h3.4" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight">SITUR</p>
              <p className="truncate text-[11px] text-white/60">
                Dirección de Catastro · Durango
              </p>
            </div>
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

      <main className="mx-auto max-w-5xl p-4 pb-10">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/*
          La columna de la ficha: la ficha del turno, los avisos y los dos
          desplegables (oponerse y aviso de privacidad).
        */}
        <div className="space-y-4">
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
              <h1 className={`text-5xl font-black leading-none tracking-tight ${estilo.texto}`}>
                {turno.codigo_turno}
              </h1>
              <p className={`mt-1.5 text-sm font-semibold ${estilo.texto}`}>
                {turno.denominacion_tramite}
              </p>
            </div>
            <p className={`mt-3 text-sm font-semibold ${estilo.texto}`}>{turno.mensaje}</p>
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
            {turno.tiempo_estimado_minutos != null && (
              <Dato
                etiqueta="Tiempo estimado"
                valor={`${turno.tiempo_estimado_minutos} min`}
                icono="reloj"
              />
            )}
            <Dato
              etiqueta="Emitido"
              valor={formatearHora(turno.creado_en)}
              icono="calendario"
            />
            {turno.llamado_en && (
              <Dato
                etiqueta="Llamado"
                valor={formatearHora(turno.llamado_en)}
                icono="reloj"
              />
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
        <aside className="space-y-4">
          <div className="rounded-2xl bg-navy-800 p-5 text-white">
            <h2 className="text-xs font-bold uppercase tracking-widest text-white/60">
              Tu turno en números
            </h2>
            <div className="mt-3 space-y-0">
              {turno.estado === 'WAITING' && (
                <div className="flex items-center justify-between border-b border-white/10 py-2.5">
                  <span className="text-sm text-white/80">Posición</span>
                  <b className="text-lg">{turno.posicion}</b>
                </div>
              )}
              {turno.estado === 'WAITING' && (
                <div className="flex items-center justify-between border-b border-white/10 py-2.5">
                  <span className="text-sm text-white/80">Personas delante</span>
                  <b className="text-lg">{turno.personas_delante}</b>
                </div>
              )}
              {turno.tiempo_estimado_minutos != null && (
                <div className="flex items-center justify-between border-b border-white/10 py-2.5">
                  <span className="text-sm text-white/80">Tiempo estimado</span>
                  <b className="text-lg">{turno.tiempo_estimado_minutos} min</b>
                </div>
              )}
              <div className="flex items-center justify-between py-2.5">
                <span className="text-sm text-white/80">Módulo</span>
                <b className="text-lg">{turno.modulo ?? '—'}</b>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-white/60">
              Solo ve los números de <strong className="text-white/80">su</strong>{' '}
              turno. El sistema no muestra los turnos de los demás ciudadanos.
            </p>
          </div>

          <div className="rounded-2xl border border-gris-200 bg-white p-5">
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
    <div className="flex items-center gap-3 px-1 py-2">
      <dt className="flex flex-1 items-center gap-3 text-sm text-gris-700">
        {icono && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-azul-50 text-azul-500">
            <IconoDato nombre={icono} />
          </span>
        )}
        {etiqueta}
      </dt>
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
