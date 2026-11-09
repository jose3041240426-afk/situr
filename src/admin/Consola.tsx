import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import BotonChispa from '../components/BotonChispa'
import BotonLlamar from '../components/BotonLlamar'
import BloqueExpandible from '../components/BloqueExpandible'
import BotonEmitir from '../components/BotonEmitir'
import BotonRepartir from '../components/BotonRepartir'
import Selector from '../components/Selector'
import NotificacionLote from '../components/NotificacionLote'
import Paginador from '../components/Paginador'
import BuscadorPapel from '../components/BuscadorPapel'
import CodigoQR from '../components/CodigoQR'
import {
  Aviso,
  Campo,
  Chip,
  ChipEstado,
  ChipPrioridad,
  EsqueletoTabla,
  Modal,
  Vacio,
} from '../components/ui'
import {
  ErrorSitur,
  abrirPeriodo,
  cancelarTurno,
  cerrarPeriodo,
  formatearFecha,
  formatearFechaHora,
  formatearSoloHora,
  finalizarTurno,
  generarTurno,
  generarTurnosMasivos,
  programarAvisoSiguiente,
  cancelarAvisoSiguiente,
  opcionesAviso,
  maximoEnAtencion,
  iniciarAtencion,
  tokenDeTurno,
  listarCola,
  listarModulos,
  obtenerPeriodoAbierto,
  listarTramites,
  listarCifrasDelPeriodo,
  listarTurnosActuales,
  listarTurnosRetirados,
  llamarSiguiente,
  omitirTurno,
  proponerSiguienteTurno,
  repetirLlamada,
} from '../lib/rpc'
import type {
  CifrasPeriodo,
  FilaActual,
  FilaCola,
  FilaRetirado,
  LoteTurnos,
  Modulo,
  PeriodoOperativo,
  PropuestaSiguiente,
  Tramite,
} from '../lib/tipos'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

/**
 * SITUR — Consola del operador.
 *
 * Es la pantalla donde se trabaja en ventanilla. El orden de las acciones
 * sigue el recorrido del turno (DRS Figura 13):
 *
 *   periodo abierto → emitir turno → llamar → atender → finalizar
 *
 * Cada botón llama a una RPC y **nunca** cambia el estado en el navegador:
 * lo que la pantalla muestra es lo que la base respondió (RF-008, RN-011).
 */
export default function Consola() {
  const { operador, puedeOperar, mfaPendiente } = useAuth()
  const navegar = useNavigate()

  const [periodoAbierto, setPeriodoAbierto] = useState<PeriodoOperativo | null>(null)
  /*
   * Bandera propia del periodo, separada de `cargando`.
   *
   * El periodo ya no viaja en el bloque grande: llega antes. Si se atara a
   * `cargando`, el chip seguiría en esqueleto esperando a las otras seis
   * consultas y se perdería la mejora.
   */
  const [periodoListo, setPeriodoListo] = useState(false)
  const [cola, setCola] = useState<FilaCola[]>([])
  /** Turnos que el titular retiró oponiéndose (RF-033). */
  const [retirados, setRetirados] = useState<FilaRetirado[]>([])
  /** Las cifras del dia, para la fila de tarjetas (RF-022). */
  const [cifras, setCifras] = useState<CifrasPeriodo | null>(null)
  const [actuales, setActuales] = useState<FilaActual[]>([])
  /**
   * Tope de turnos abiertos a la vez (migración 010).
   *
   * Físicamente un operador tiene UNA ventanilla: un turno SERVING es alguien
   * sentado delante y los CALLED son ciudadanos caminando hacia ella. Sin
   * tope, llamar varias veces sin cerrar los anteriores hace crecer el panel
   * «En atención ahora» hasta empujar «Llamar» fuera de la pantalla.
   *
   * Se lee de `configuracion` (3 por defecto): es una política de la
   * dependencia, no una preferencia del operador.
   */
  const [maximoAtencion, setMaximoAtencion] = useState(3)

  /** El turno que esta en atencion ahora, si hay alguno. */
  const enAtencion =
    actuales.find((t) => t.estado === 'SERVING') ??
    actuales.find((t) => t.estado === 'CALLED') ??
    null

  /*
   * ¿Se alcanzó el tope de turnos abiertos? (migración 010)
   *
   * `actuales` son justo los CALLED + SERVING del operador, que es lo que
   * cuenta el límite. Cuando se llega, «Llamar» se deshabilita y se explica
   * por qué: dejar que el servidor rechace la llamada daría un error sin
   * contexto («límite excedido») cuando el operador solo quería llamar al
   * siguiente.
   */
  const topeAtencion = actuales.length >= maximoAtencion

  const [tramites, setTramites] = useState<Tramite[]>([])
  const [modulos, setModulos] = useState<Modulo[]>([])

  const [aviso, setAviso] = useState<{ tono: 'ok' | 'alerta' | 'peligro'; texto: string } | null>(null)
  const [cargando, setCargando] = useState(true)
  const [ocupado, setOcupado] = useState(false)
  /**
   * Cuándo se leyó la cola por última vez (Nielsen H1: visibilidad del
   * estado del sistema). Sin esto, si la red se cae el operador sigue
   * viendo una cola vieja y no lo sabe: llama a un turno que ya no está.
   */
  const [actualizado, setActualizado] = useState<Date | null>(null)

  // Emisión
  const [tramiteId, setTramiteId] = useState('')
  const [prioridad, setPrioridad] = useState<'NORMAL' | 'PREFERENTE' | 'URGENTE'>('NORMAL')
  const [emitido, setEmitido] = useState<{ codigo: string; token: string } | null>(null)

  // Emisión masiva (migración 009). Un renglón por trámite con su cantidad.
  const [modoMasivo, setModoMasivo] = useState(false)
  const [lotes, setLotes] = useState<LoteTurnos[]>([])
  /** Qué se emitió en el último lote, para poder imprimir o dictar los folios. */
  const [loteEmitido, setLoteEmitido] = useState<
    { total: number; turnos: Array<{ codigo: string; tramite: string }> } | null
  >(null)

  // Aviso programado al siguiente (migración 009).
  const [minutosAviso, setMinutosAviso] = useState<number[]>([])
  const [avisoProgramado, setAvisoProgramado] = useState<
    { codigo: string; minutos: number; turnoId: string } | null
  >(null)

  // Llamada
  const [moduloFiltro, setModuloFiltro] = useState('')
  const [turnoLlamado, setTurnoLlamado] = useState<FilaActual | null>(null)
  /** La propuesta del sistema, con su razón (P5). */
  const [propuesta, setPropuesta] = useState<PropuestaSiguiente | null>(null)

  /**
   * La confirmacion de la llamada (RF-029).
   *
   * Antes, «Llamar» llamaba directamente: un clic y el estado de un turno
   * de un ciudadano cambiaba a «En atención». Ahora el boton abre un
   * dialogo con a quien va a llamar el sistema y con lo que va a pasar, y
   * la llamada solo sale de ahi. Es una confirmacion, no un adorno.
   */
  const [confirmandoLlamada, setConfirmandoLlamada] = useState(false)
  const [modalMotivo, setModalMotivo] = useState<
    { turno: FilaActual; accion: 'omitir' | 'cancelar' } | null
  >(null)
  /*
   * ¿Ya se sabe el estado del periodo?
   *
   * Mientras `cargando` es true, `periodoAbierto` vale `null` —que significa
   * «no hay periodo abierto», no «todavía no lo sé»—. Sin esta bandera, al
   * entrar se pintaba «Cerrado» y el botón verde «Abrir periodo de hoy», y un
   * instante después saltaba a «Abierto» y «Cerrar periodo». El operador veía
   * un cambio de estado que nunca ocurrió.
   *
   * La distinción importa: `null` es un DATO (no hay periodo), no un
   * «cargando».
   */
  /*
   * El esqueleto se mantiene hasta que TODO está listo: el periodo y las
   * consultas de la consola.
   *
   * Antes solo miraba `periodoListo`. Como esa consulta es la más rápida,
   * podía terminar antes que las demás y la barra pintaba su contenido real
   * con la cola todavía cargando: la pantalla seguía «a medio hacer» justo el
   * instante en que el operador estaba mirando. Esperando a las dos, el
   * esqueleto cubre el total y desaparece de una vez.
   */
  const estadoPeriodoListo = periodoListo && !cargando
  /** Confirmación del cierre de periodo (Nielsen H5: acción destructiva). */
  const [confirmandoCierre, setConfirmandoCierre] = useState(false)
  /** Un turno en espera que el operador quiere cancelar (trámite equivocado). */
  const [cancelando, setCancelando] = useState<FilaCola | null>(null)

  /*
   * La cola se muestra por páginas de 10.
   *
   * Un día normal deja decenas de turnos en espera, y la tabla entera
   * empujaba hacia abajo las confirmaciones y los avisos. 10 es el tramo que
   * cabe en una pantalla de ventanilla sin desplazarse.
   */
  const POR_PAGINA = 10
  const [paginaCola, setPaginaCola] = useState(1)

  /*
   * Turno cuyo QR se está mostrando, con su token ya resuelto. Se guarda el
   * código para el encabezado y el token para pintar el código.
   */
  const [qrTurno, setQrTurno] = useState<{ codigo: string; token: string } | null>(null)

  /** Confirma que el enlace se copió, durante unos segundos. */
  const [copiadoQr, setCopiadoQr] = useState(false)

  /*
   * Filtro por trámite de la cola. Cadena vacía = todos.
   *
   * Existe porque el operador en ventanilla solo puede atender ciertos
   * trámites (los de su módulo), y con 40 turnos mezclados tiene que buscar a
   * ojo cuál es el suyo. Filtrando, la primera fila ya es un candidato real.
   */
  const [filtroTramite, setFiltroTramite] = useState('')

  const urlQr = qrTurno ? `${window.location.origin}/turno/${qrTurno.token}` : ''

  /*
   * El tramo visible. Si la cola se acorta (se atendieron turnos) y la página
   * actual se queda vacía, se retrocede a la última que existe: sin esto, el
   * operador vería una tabla en blanco sin saber por qué.
   */
  /*
   * La cola filtrada. Se filtra ANTES de paginar para que las páginas
   * correspondan a lo que se está viendo, no al total.
   */
  const colaFiltrada = filtroTramite
    ? cola.filter((f) => f.clave_tramite === filtroTramite)
    : cola

  /*
   * Los trámites que de verdad tienen turnos esperando, con cuántos. Se
   * calcula sobre la cola completa y no sobre lo filtrado: así el operador ve
   * de un golpe dónde hay trabajo y cuánto.
   */
  const tramitesEnCola = useMemo(() => {
    const mapa = new Map<string, { clave: string; denominacion: string; n: number }>()
    for (const f of cola) {
      const previo = mapa.get(f.clave_tramite)
      if (previo) previo.n += 1
      else
        mapa.set(f.clave_tramite, {
          clave: f.clave_tramite,
          denominacion: f.denominacion_tramite,
          n: 1,
        })
    }
    return [...mapa.values()].sort((a, b) => b.n - a.n || a.clave.localeCompare(b.clave))
  }, [cola])

  const paginasCola = Math.max(1, Math.ceil(colaFiltrada.length / POR_PAGINA))
  const paginaActual = Math.min(paginaCola, paginasCola)
  const colaPagina = colaFiltrada.slice(
    (paginaActual - 1) * POR_PAGINA,
    paginaActual * POR_PAGINA,
  )

  /*
   * Dirección del último cambio de página, para que el barrido de la tabla
   * vaya hacia donde se movió el operador.
   *
   * Sin esto la animación siempre entraría por el mismo lado, y pasar de la
   * página 3 a la 2 se sentiría como avanzar. Se guarda la página anterior en
   * una ref y se compara al cambiar.
   */
  const paginaAnterior = useRef(paginaActual)
  const direccion = paginaActual > paginaAnterior.current ? 'derecha' : 'izquierda'
  useEffect(() => {
    paginaAnterior.current = paginaActual
  }, [paginaActual])

  const hoy = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
  }, [])

  /*
   * El periodo se carga en su PROPIA petición, aparte del bloque grande.
   *
   * Antes iba dentro del `Promise.all` con las otras seis consultas, así que
   * el estado del periodo —y con él su botón— esperaba a la más lenta: medio
   * segundo en local. Estando fuera, aparece en cuanto llega su consulta, que
   * es la más ligera de todas.
   */
  const cargar = useCallback(async () => {
    try {
      /*
       * El periodo se pide SUELTO, no dentro del `Promise.all`.
       *
       * Se lanza aquí pero se pinta con su propio `.then`, así que el chip y
       * el botón aparecen en cuanto llega esa consulta —la más ligera— sin
       * esperar a las otras seis. Una sola petición: antes se pedía dos veces
       * (una por el efecto y otra por este bloque).
       */
      const promesaPeriodo = obtenerPeriodoAbierto()
        .then((p) => {
          setPeriodoAbierto(p)
          setPeriodoListo(true)
          return p
        })
        .catch(() => {
          /* Si falla, el chip se queda en esqueleto: pintar «Cerrado» por un
             error de red ofrecería abrir un periodo que ya está abierto. */
          return null
        })

      const [c, a, ts, ms, rt, cf] = await Promise.all([
        listarCola(),
        listarTurnosActuales(),
        listarTramites(),
        listarModulos(),
        listarTurnosRetirados(),
        listarCifrasDelPeriodo(),
      ])
      setCola(c)
      setActuales(a)
      setRetirados(rt)
      setCifras(cf)
      setTramites(ts)
      setModulos(ms)
      setActualizado(new Date())
      if (!tramiteId && ts.length > 0) setTramiteId(ts[0].id)

      /*
       * La propuesta: qué va a llamar el sistema y por qué (P5 + P11).
       * Solo tiene sentido si hay un periodo abierto.
       *
       * Se reutiliza la consulta del periodo en vez de lanzar otra: es la
       * misma que dispara el efecto de arriba, y pedirla dos veces haría dos
       * viajes a la base para el mismo dato.
       */
      if (await promesaPeriodo) {
        try {
          setPropuesta(await proponerSiguienteTurno())
        } catch {
          setPropuesta(null)
        }
      } else {
        setPropuesta(null)
      }

      /*
       * El tope de turnos abiertos (migración 010). Si falla, se queda en 3:
       * la consola nunca debe quedarse sin límite por un error de red, y 3 es
       * el valor por defecto de la dependencia.
       */
      try {
        setMaximoAtencion(await maximoEnAtencion())
      } catch {
        setMaximoAtencion(3)
      }
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo cargar la consola.',
      })
    } finally {
      setCargando(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void cargar()
  }, [cargar])

  // Opciones de aviso (5, 10, 15). Las decide la dependencia en `configuracion`,
  // así que no se codifican aquí: si cambian en la base, la consola cambia sola.
  useEffect(() => {
    opcionesAviso()
      .then((m) => setMinutosAviso(m))
      .catch(() => setMinutosAviso([5, 10, 15]))
  }, [])

  // Refresco periódico: la base es la autoridad y el panel refleja lo que
  // hay, sin depender de que llegue un evento.
  useEffect(() => {
    const t = setInterval(() => void cargar(), 15000)
    return () => clearInterval(t)
  }, [cargar])

  // Se suscribe a los cambios de `turnos`; el evento solo avisa de que algo
  // cambió: el panel vuelve a leer las vistas (no se transportan datos).
  useEffect(() => {
    const canal = supabase.channel(`situr-consola-${Math.random().toString(36).slice(2)}`)
    canal
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'turnos' },
        () => void cargar(),
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(canal)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargar])

  // ------------------------------------------------------------------ acciones

  async function ejecutar(fn: () => Promise<unknown>, exito: string) {
    setOcupado(true)
    setAviso(null)
    try {
      await fn()
      setAviso({ tono: 'ok', texto: exito })
      await cargar()
      return true
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'La operación no se pudo completar.',
      })
      return false
    } finally {
      setOcupado(false)
    }
  }

  async function abrir() {
    await ejecutar(() => abrirPeriodo(hoy), `Periodo ${hoy} abierto.`)
  }

  async function cerrar() {
    if (!periodoAbierto) return
    const ok = await ejecutar(
      () => cerrarPeriodo(periodoAbierto.id),
      `Periodo ${formatearFecha(periodoAbierto.clave)} cerrado. Los turnos en espera se omitieron.`,
    )
    if (ok) setTurnoLlamado(null)
  }

  async function emitir() {
    if (!tramiteId) return
    setOcupado(true)
    setAviso(null)
    try {
      const r = await generarTurno(tramiteId, prioridad)
      setEmitido({ codigo: r.codigo_turno, token: r.token_publico })
      await cargar()
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo emitir el turno.',
      })
    } finally {
      setOcupado(false)
    }
  }

  /**
   * Emite un lote de turnos (migración 009).
   *
   * Se envía solo lo que el operador llenó: los renglones con cantidad 0 no
   * viajan. La base es atómica, así que un error aquí deja la cola intacta.
   */
  async function emitirMasivo() {
    const pedido = lotes.filter((l) => l.cantidad > 0)
    if (pedido.length === 0) return

    setOcupado(true)
    setAviso(null)
    try {
      const r = await generarTurnosMasivos(pedido)
      setLoteEmitido({
        total: r.total,
        turnos: r.turnos.map((t) => ({ codigo: t.codigo, tramite: t.tramite })),
      })
      setLotes([])
      await cargar()
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo emitir el lote.',
      })
    } finally {
      setOcupado(false)
    }
  }

  /**
   * Programa el aviso push del siguiente turno (migración 009).
   *
   * El operador elige 5, 10 o 15 minutos y al ciudadano que está en esa
   * posición le llega la notificación cuando se cumple el plazo.
   */
  async function programarAviso(minutos: number) {
    setOcupado(true)
    setAviso(null)
    try {
      const r = await programarAvisoSiguiente(minutos)
      setAvisoProgramado({
        codigo: r.codigo_turno,
        minutos: r.minutos,
        turnoId: r.turno_id,
      })
      setAviso({
        tono: 'ok',
        texto: `Aviso programado: al turno ${r.codigo_turno} le llegará la notificación en ${r.minutos} minutos.`,
      })
      await cargar()
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo programar el aviso.',
      })
    } finally {
      setOcupado(false)
    }
  }

  /** Deshace el aviso programado antes de que salga. */
  async function cancelarAviso() {
    if (!avisoProgramado) return
    setOcupado(true)
    try {
      await cancelarAvisoSiguiente(avisoProgramado.turnoId)
      setAvisoProgramado(null)
      setAviso({ tono: 'ok', texto: 'Aviso cancelado.' })
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo cancelar el aviso.',
      })
    } finally {
      setOcupado(false)
    }
  }

  async function llamar() {
    setOcupado(true)
    setAviso(null)
    try {
      const r = await llamarSiguiente(
        moduloFiltro || null,
        null, // Opción C del punto 10: con null la cola es global (RN-017).
      )
      setTurnoLlamado({
        turno_id: r.turno_id,
        codigo_turno: r.codigo_turno,
        folio: r.folio,
        estado: r.estado,
        prioridad: r.prioridad,
        creado_en: '',
        llamado_en: r.llamado_en,
        inicio_atencion: null,
        numero_llamadas: r.numero_llamadas,
        periodo_operativo_id: '',
        tramite_id: '',
        clave_tramite: r.clave_tramite,
        denominacion_tramite: r.denominacion_tramite,
        modulo_id: null,
        codigo_modulo: r.codigo_modulo,
        denominacion_modulo: r.denominacion_modulo,
        trabajador_id: null,
        nombre_trabajador: r.operador,
        numero_empleado: null,
      })
      await cargar()
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo llamar al siguiente turno.',
      })
    } finally {
      setOcupado(false)
    }
  }

  async function conTurno(fn: () => Promise<unknown>, exito: string) {
    const ok = await ejecutar(fn, exito)
    if (ok) setTurnoLlamado(null)
  }

  /**
   * Redirigir la llamada a un turno concreto de la cola (P10).
   *
   * Es lo que evita tener que omitir al que "no toca": omitir quema el turno
   * de ese ciudadano. Aquí los demás siguen intactos.
   */
  /**
   * Abre el QR de un turno de la cola.
   *
   * El token se pide en ese momento y no al cargar la cola: pedir un token
   * por cada fila visible serían diez consultas para algo que casi nunca se
   * usa. Aquí es una sola, y solo cuando el operador la pide.
   */
  async function abrirQr(f: FilaCola) {
    setOcupado(true)
    setAviso(null)
    try {
      const token = await tokenDeTurno(f.turno_id)
      setQrTurno({ codigo: f.codigo_turno, token })
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo obtener el código QR.',
      })
    } finally {
      setOcupado(false)
    }
  }

  /**
   * Copia el enlace del turno al portapapeles.
   *
   * `navigator.clipboard` solo existe en contextos seguros (HTTPS o
   * localhost). En una ventanilla servida por HTTP plano no está, así que hay
   * un respaldo con un `textarea` temporal: sin él, el botón fallaría en
   * silencio justo en el entorno donde más se usa.
   */
  async function copiarQr() {
    if (!urlQr) return
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(urlQr)
      } else {
        const area = document.createElement('textarea')
        area.value = urlQr
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      }
      setCopiadoQr(true)
      window.setTimeout(() => setCopiadoQr(false), 2500)
    } catch {
      setAviso({ tono: 'peligro', texto: 'No se pudo copiar el enlace.' })
    }
  }

  // ------------------------------------------------------------------ pantalla

  if (!puedeOperar) {
    return (
      <Aviso tono="alerta">
        Su cuenta no tiene permiso para operar turnos. Consulte con el administrador.
      </Aviso>
    )
  }

  return (
    <>
      {mfaPendiente && (
        <div className="mb-4">
          <Aviso tono="alerta">
            Debe configurar la verificación en dos pasos antes de operar (RF-026).{' '}
            <button
              type="button"
              onClick={() => navegar('/admin')}
              className="font-bold underline"
            >
              Configurarla
            </button>
          </Aviso>
        </div>
      )}

      {/*
        Mientras no se sabe el estado del periodo se dibuja la barra entera
        como esqueleto, con la misma forma que la real.
        Sustituye a un texto «Comprobando periodo…» y a un chip gris suelto:
        ambos seguían siendo un cambio visible en el sitio más mirado de la
        pantalla. Un esqueleto con la forma final no cambia de tamaño ni de
        composición al llegar los datos, así que no se percibe el salto.
      */}
      {!estadoPeriodoListo ? (
        <section className="tarjeta mb-6 p-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Comprobando el periodo operativo…</span>
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-48">
              <div className="esqueleto-bloque mb-2 h-3 w-32 rounded" />
              <div className="flex items-center gap-2">
                <div className="esqueleto-bloque h-6 w-24 rounded" />
                <div className="esqueleto-bloque h-5 w-16 rounded-full" />
              </div>
              <div className="esqueleto-bloque mt-2 h-3 w-28 rounded" />
            </div>
            {/* Mismo alto que el botón con chispa, para que nada se mueva. */}
            <div className="esqueleto-bloque h-11 w-44 rounded-xl" />
          </div>
        </section>
      ) : (
      <section className="tarjeta transicion-datos mb-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gris-500">
              Periodo operativo
            </p>
            <p className="mt-1 flex items-center gap-2 text-lg font-bold text-navy-800">
              {formatearFecha(periodoAbierto ? periodoAbierto.clave : hoy)}
              {periodoAbierto ? (
                <Chip tono="ok">Abierto</Chip>
              ) : (
                <Chip tono="peligro">Cerrado</Chip>
              )}
            </p>
            {periodoAbierto?.hora_inicio && (
              <p className="mt-1 text-xs text-gris-500">
                Abierto a las {formatearSoloHora(periodoAbierto.hora_inicio)}
              </p>
            )}
          </div>
          {/*
            El color sigue al estado, no al botón: con el periodo abierto la
            acción es cerrar (rojo, destructiva); con el periodo cerrado la
            acción es abrir (verde, habilita la jornada). Así el operador sabe
            qué va a pasar antes de leer el texto.
          */}
          {periodoAbierto ? (
            <BotonChispa
              tono="rojo"
              onClick={() => setConfirmandoCierre(true)}
              disabled={ocupado}
            >
              Cerrar periodo
            </BotonChispa>
          ) : (
            <BotonChispa tono="verde" onClick={() => void abrir()} disabled={ocupado}>
              Abrir periodo de hoy
            </BotonChispa>
          )}
        </div>
      </section>
      )}

      {aviso && (
        /*
         * `role="status"`: el aviso aparece y desaparece sin que recargue la
         * página, así que un lector de pantalla no se enteraría de que la
         * operación se hizo (WCAG 4.1.3, nivel AA).
         */
        <div role="status" aria-live="polite" className="mb-6">
          <Aviso tono={aviso.tono}>{aviso.texto}</Aviso>
        </div>
      )}

      {/*
        LA FILA DE CIFRAS.

        Lo primero que mira el operador al llegar a la ventanilla: qué turno
        tiene delante, a cuál le toca ahora y cómo va la mañana. Antes eso
        estaba repartido en tres sitios (la propuesta, «En atención ahora» y
        las estadísticas); aquí está junto, arriba, y se lee de un vistazo.

        La primera tarjeta va en azul: es la que mira, la que cambia.
      */}
      {cargando ? (
        /*
         * Esqueleto de las tres tarjetas mientras llegan los datos.
         *
         * Sin esto se pintaban con «—» y «No hay turnos en espera»: mensajes
         * que AFIRMAN algo falso. Un guion no significa «cargando», significa
         * «no hay».
         */
        <div className="mb-6 grid gap-5 sm:grid-cols-3" aria-busy="true">
          <span className="sr-only">Cargando el resumen del día…</span>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} aria-hidden="true" className="tarjeta p-6">
              <div className="esqueleto-bloque mb-3 h-3 w-24 rounded" />
              <div className="esqueleto-bloque mb-3 h-8 w-28 rounded" />
              <div className="esqueleto-bloque h-3 w-2/3 rounded" />
            </div>
          ))}
        </div>
      ) : (
      <div className="transicion-datos mb-6 grid gap-5 sm:grid-cols-3">
        <TarjetaCifra
          rotulo="Turno actual"
          valor={enAtencion?.codigo_turno ?? '—'}
          pie={
            enAtencion
              ? `${enAtencion.denominacion_tramite} · módulo ${enAtencion.codigo_modulo ?? '—'}`
              : 'No hay ningún turno en atención'
          }
          icono="persona"
          destacado
        />
        <TarjetaCifra
          rotulo="Siguiente turno"
          valor={propuesta?.hay_turnos ? (propuesta.codigo_turno ?? '—') : '—'}
          pie={
            propuesta?.hay_turnos
              ? `${propuesta.denominacion_tramite ?? ''} · en espera`
              : 'No hay turnos en espera'
          }
          icono="lista"
        />
        <TarjetaCifra
          rotulo="Atendidos hoy"
          valor={cifras ? String(cifras.atendidos) : '—'}
          pie={
            cifras
              ? `${cifras.generados} generados · ${cifras.en_espera} en espera`
              : 'Cargando…'
          }
          icono="grafico"
        />
      </div>
      )}

      {/* `min-w-0` en los hijos: sin eso, un hijo de la rejilla no baja del
          ancho de su contenido (un <select> con opciones largas) y la pagina
          desborda en horizontal a 320 px (WCAG 1.4.10). */}
      <div className="grid gap-5 xl:grid-cols-[22rem_1fr]">
        {/* ------------------------------------------------ emitir turno */}
        <div className="min-w-0 space-y-5">
          <section className="tarjeta p-6">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
              Emitir turno
            </h2>

            {cargando ? (
              /* Si aún no se sabe el estado del periodo, avisar de que «no hay
                 periodo abierto» sería afirmar algo que quizá no es cierto. */
              <div className="mt-4 space-y-3" aria-busy="true">
                <span className="sr-only">Cargando la emisión de turnos…</span>
                <div aria-hidden="true" className="esqueleto-bloque h-4 w-40 rounded" />
                <div aria-hidden="true" className="esqueleto-bloque h-10 w-full rounded-lg" />
                <div aria-hidden="true" className="esqueleto-bloque h-10 w-40 rounded-lg" />
              </div>
            ) : !periodoAbierto ? (
              <p className="mt-4 rounded-xl bg-ambar-50 px-4 py-3 text-sm text-ambar-600">
                No hay periodo abierto. Sin él, la base rechaza cualquier alta de turno
                (RF-025).
              </p>
            ) : (
              <div className="mt-5 space-y-5">{/* space-y-5: con 16px el campo
                de Prioridad y el texto de RN-017 quedaban a la misma
                distancia que su propia etiqueta, y no se distinguía a qué
                campo pertenecía cada texto. */}
                {/* Dos modos: un turno, o un lote. Se separan en vez de meter
                    un campo «cantidad» en el formulario de siempre, porque
                    emitir 100 turnos no es lo mismo que emitir uno y no debe
                    parecerlo. */}
                {/*
                  Selector de cristal deslizante.

                  Antes eran dos <button> con `aria-pressed`. Eso describía dos
                  botones independientes, no una elección entre dos opciones.
                  Aquí son RADIOS de verdad: el lector anuncia «opción 1 de 2»
                  y las flechas del teclado cambian de modo solas. La pastilla
                  que se desliza es solo la representación visual.

                  `name` distinto de cualquier otro grupo de la página para que
                  el teclado no los mezcle.
                */}
                <div
                  className="glass-radio-group"
                  role="radiogroup"
                  aria-label="Modo de emisión"
                >
                  <input
                    type="radio"
                    name="modo-emision"
                    id="modo-un-turno"
                    checked={!modoMasivo}
                    onChange={() => setModoMasivo(false)}
                  />
                  <label htmlFor="modo-un-turno">Un turno</label>

                  <input
                    type="radio"
                    name="modo-emision"
                    id="modo-varios-turnos"
                    checked={modoMasivo}
                    onChange={() => setModoMasivo(true)}
                  />
                  <label htmlFor="modo-varios-turnos">Varios turnos</label>

                  <div className="glass-glider" aria-hidden="true" />
                </div>

                <BloqueExpandible clave={modoMasivo}>
                {!modoMasivo ? (
                  /*
                   * `space-y-6` AQUÍ, no en el div de arriba.
                   *
                   * El div padre tiene `space-y-5`, pero su hijo directo es
                   * `BloqueExpandible`, no los campos: el espacio se aplicaba
                   * entre bloques, no entre los tres controles. Poniendo el
                   * `space-y` en el fragmento, cada `Campo` y el botón pasan a
                   * ser hijos con separación real.
                   */
                  <div className="space-y-6">
                    {/*
                      `Selector` y no `<select>`: la lista nativa se ensancha
                      al texto más largo («REG — Registro catastral» no cabe en
                      el ancho del campo) e ignora el `width` del control.

                      `grupo`: el control no es un campo nativo, así que la
                      etiqueta visible va en un `<div>`. Un botón dentro de un
                      `<label>` es HTML inválido y además hace que al pulsar la
                      etiqueta se abra el desplegable.
                    */}
                    <Campo etiqueta="Trámite" grupo>
                      <Selector
                        etiqueta="Trámite"
                        className="w-full"
                        valor={tramiteId}
                        onCambiar={setTramiteId}
                        opciones={tramites.map((t) => ({
                          valor: t.id,
                          etiqueta: `${t.clave} — ${t.denominacion}`,
                        }))}
                      />
                    </Campo>

                    <Campo
                      etiqueta="Prioridad"
                      ayuda="RN-017: URGENTE sale antes que el resto."
                      grupo
                    >
                      <Selector
                        etiqueta="Prioridad"
                        className="w-full"
                        valor={prioridad}
                        onCambiar={(v) => setPrioridad(v as typeof prioridad)}
                        opciones={[
                          { valor: 'NORMAL', etiqueta: 'Normal' },
                          { valor: 'PREFERENTE', etiqueta: 'Preferente' },
                          { valor: 'URGENTE', etiqueta: 'Urgente' },
                        ]}
                      />
                    </Campo>

                    {/* El botón se separa más que un campo: es la acción final
                        del formulario y conviene que no se lea como un
                        tercer campo más. */}
                    <div className="pt-1">
                    <BotonEmitir
                      onClick={() => void emitir()}
                      disabled={ocupado || !tramiteId}
                    >
                      Emitir turno
                    </BotonEmitir>
                    </div>
                  </div>
                ) : (
                  <EmisionMasiva
                    tramites={tramites}
                    lotes={lotes}
                    onCambiar={setLotes}
                    onEmitir={() => void emitirMasivo()}
                    ocupado={ocupado}
                  />
                )}
                </BloqueExpandible>
              </div>
            )}
          </section>

          {emitido && (
            <section className="tarjeta p-6 impresion-boleto">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
                    Turno emitido
                  </h2>
                  <p className="mt-1 text-2xl font-black text-navy-800">
                    {emitido.codigo}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEmitido(null)}
                  className="no-imprimir rounded-lg p-1 text-gris-500 hover:bg-gris-50"
                  aria-label="Cerrar"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="mt-3 flex flex-col items-center">
                <CodigoQR valor={`${window.location.origin}/turno/${emitido.token}`} />
                <p className="mt-2 max-w-[15rem] break-all text-center font-mono text-[10px] text-gris-500">
                  {emitido.token}
                </p>
              </div>

              {/*
                El token impreso en el boleto es la credencial del
                ciudadano: con el cualquiera puede ver su turno. Por eso
                el QR va con una nota que lo dice.
              */}
              <p className="mx-auto mt-3 max-w-[15rem] text-[10px] leading-relaxed text-gris-500">
                Este código es la credencial de su turno: no lo comparta ni
                lo muestre en público.
              </p>

              <div className="no-imprimir mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="boton-secundario flex-1"
                >
                  Imprimir
                </button>
                <a
                  href={`/turno/${emitido.token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="boton-secundario flex-1"
                >
                  Ver
                </a>
              </div>
            </section>
          )}

          {/* Aviso programado al siguiente turno (migración 009). */}
          <PanelAviso
            minutos={minutosAviso}
            programado={avisoProgramado}
            onProgramar={(m) => void programarAviso(m)}
            onCancelar={() => void cancelarAviso()}
            ocupado={ocupado}
            deshabilitado={!periodoAbierto || cola.length === 0}
            cargando={cargando}
          />

          {/*
           * Módulos.
           *
           * `mb-1` extra: es la última tarjeta de la columna izquierda y en
           * pantallas anchas queda alineada con el pie de la columna derecha,
           * así que necesita un poco más de aire abajo para no quedar pegada
           * al borde de la rejilla.
           */}
          <section className="tarjeta mb-1 p-6">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
              Módulos
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {modulos.map((m) => (
                <Chip key={m.id} tono={m.estado === 'ACTIVO' ? 'ok' : 'neutro'}>
                  {m.codigo}
                  {m.estado !== 'ACTIVO' ? ` · ${m.estado === 'PAUSADO' ? 'Pausado' : 'Fuera'}` : ''}
                </Chip>
              ))}
            </div>
            {operador?.modulo && (
              <p className="mt-2 text-xs text-gris-500">
                Su módulo: <strong>{operador.modulo}</strong>. Si está activo, «llamar
                siguiente» enruta ahí (RG-004).
              </p>
            )}
          </section>
        </div>

        {/* ------------------------------------------------ atención */}
        <div className="min-w-0 space-y-5">
          {/*
            «En atención ahora» va PRIMERO.

            Antes estaba debajo de «Llamar siguiente», y el orden contaba la
            historia al revés: arriba la acción de llamar y abajo el estado
            actual. Pero un operador trabaja al revés —mira qué está atendiendo
            y después decide a quién llama— y además la acción ocupaba el sitio
            de más peso visual, que es el del estado.

            Este panel es ahora el ÚNICO lugar donde se gestiona un turno ya
            llamado: aquí viven Repetir, Omitir, Cancelar, Iniciar atención y
            Finalizar.
          */}
          {/* En atención ahora */}
          <section className="tarjeta overflow-hidden">
            <div className="border-b border-gris-100 px-6 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
                  En atención ahora
                </h2>
                {/*
                  El contador hace visible el límite antes de chocar con él:
                  «2 de 3» explica por sí solo por qué el próximo es el
                  último que se puede llamar.
                */}
                {!cargando && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                      topeAtencion
                        ? 'bg-ambar-50 text-ambar-600'
                        : 'bg-gris-100 text-gris-700'
                    }`}
                  >
                    {actuales.length} de {maximoAtencion}
                  </span>
                )}
              </div>
            </div>
            {cargando ? (
              /* Mientras carga no se puede afirmar «no hay turnos»: eso es un
                 dato, no un estado de espera. */
              <div className="space-y-3 px-6 py-4" aria-busy="true">
                <span className="sr-only">Cargando turnos en curso…</span>
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} aria-hidden="true" className="flex items-center gap-4">
                    <div className="esqueleto-bloque h-5 w-28 rounded" />
                    <div className="esqueleto-bloque h-4 w-40 rounded" />
                    <div className="esqueleto-bloque ml-auto h-8 w-28 rounded-lg" />
                  </div>
                ))}
              </div>
            ) : actuales.length === 0 ? (
              <Vacio titulo="No hay turnos en curso" detalle="Los turnos llamados y en atención aparecen aquí." />
            ) : (
              <>
                {/*
                  Al llegar al tope se dice QUÉ hacer, no solo que está lleno.
                  El límite existe para que nadie acumule ciudadanos llamados
                  sin atenderlos, así que la salida siempre es cerrar uno.
                */}
                {topeAtencion && (
                  <div className="flex items-start gap-2 border-b border-ambar-500/30 bg-ambar-50 px-6 py-3">
                    <span className="mt-0.5 shrink-0 text-ambar-600" aria-hidden="true">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 8v5M12 16.5v.5" />
                        <circle cx="12" cy="12" r="9" />
                      </svg>
                    </span>
                    <p className="text-xs leading-snug text-navy-800">
                      Ya tiene <strong>{actuales.length}</strong> turnos abiertos, el
                      máximo permitido. Finalice, omita o cancele uno para poder llamar
                      al siguiente.
                    </p>
                  </div>
                )}
                {/*
                  `max-h` + `overflow-y-auto` como red de seguridad: si por
                  datos viejos o un límite recién subido aparecen más turnos
                  que el tope, el panel se desplaza en vez de crecer sin fin y
                  empujar «Llamar» fuera de la pantalla.
                */}
                <ul className="transicion-datos max-h-[26rem] divide-y divide-gris-100 overflow-y-auto">
                {actuales.map((t) => (
                  <li key={t.turno_id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold text-navy-800">
                          {t.codigo_turno}
                        </span>
                        <ChipEstado estado={t.estado} />
                        <ChipPrioridad prioridad={t.prioridad} />
                      </div>
                      <p className="truncate text-xs text-gris-500">
                        {t.denominacion_tramite}
                        {t.codigo_modulo ? ` · ${t.codigo_modulo}` : ''}
                        {t.nombre_trabajador ? ` · ${t.nombre_trabajador}` : ''}
                        {t.llamado_en ? ` · llamado ${formatearSoloHora(t.llamado_en)}` : ''}
                      </p>
                    </div>
                    {/*
                      Las acciones del turno llamado viven AQUÍ, en la lista
                      persistente, y no solo en el panel que aparece justo
                      después de pulsar «Llamar». Antes, si la página se
                      recargaba, un turno llamado pero no atendido se quedaba
                      sin «Repetir», sin «Omitir» y sin «Cancelar»: solo
                      «Atender» (Nielsen H3).
                    */}
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {t.estado === 'CALLED' && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void conTurno(
                                () => repetirLlamada(t.turno_id),
                                'Llamada repetida.',
                              )
                            }
                            disabled={ocupado}
                            className="boton-secundario whitespace-nowrap px-3 py-1.5 text-xs"
                            title="Volver a llamar a este ciudadano"
                          >
                            Repetir
                          </button>
                          <button
                            type="button"
                            onClick={() => setModalMotivo({ turno: t, accion: 'omitir' })}
                            disabled={ocupado}
                            className="boton-secundario whitespace-nowrap px-3 py-1.5 text-xs"
                            title="El ciudadano no se presentó. Podrá reponerse en ventanilla."
                          >
                            Omitir
                          </button>
                          <button
                            type="button"
                            onClick={() => setModalMotivo({ turno: t, accion: 'cancelar' })}
                            disabled={ocupado}
                            className="boton-peligro px-3 py-1.5 text-xs"
                            title="Se cancela la solicitud del ciudadano. No se puede reponer."
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void conTurno(
                                () => iniciarAtencion(t.turno_id),
                                'Atención iniciada.',
                              )
                            }
                            disabled={ocupado}
                            className="boton-primario whitespace-nowrap px-3 py-1.5 text-xs"
                            title="El ciudadano ya está en la ventanilla. Empieza a contar el tiempo de atención."
                          >
                            Iniciar atención
                          </button>
                        </>
                      )}
                      {t.estado === 'SERVING' && (
                        <button
                          type="button"
                          onClick={() =>
                            void conTurno(
                              () => finalizarTurno(t.turno_id),
                              'Turno finalizado.',
                            )
                          }
                          disabled={ocupado}
                          className="boton-ok px-3 py-1.5 text-xs"
                        >
                          Finalizar
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              </>
            )}
          </section>
          <section className="tarjeta p-6">
            <div className="flex flex-wrap items-center justify-between gap-5">
              <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
                Llamar siguiente
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {/*
                  Este selector no va dentro de un <label>: es un control
                  suelto en la cabecera, y sin nombre accesible un lector de
                  pantalla anuncia «combo box» a secas (WCAG 4.1.2, critico).
                  El `max-w` y el `min-w-0` son para que a 320 px no imponga
                  su ancho intrínseco (el de la opción más larga) y desborde
                  la fila (WCAG 1.4.10).
                */}
                {/*
                  Mismo `.selector` que el campo Trámite de «Emitir turno»,
                  sin utilidades que lo sobrescriban.

                  Antes llevaba `py-2 text-sm`, que pisaban el `py-2.5` y la
                  altura de 42px del componente: este control medía 2px menos
                  que los demás y el texto salía más pequeño. Se veía de otra
                  familia que el resto del formulario.

                  `max-w-[13rem]` se mantiene porque a 320 px la opción más
                  larga impondría su ancho intrínseco y desbordaría la fila
                  (WCAG 1.4.10).
                */}
                <Selector
                  etiqueta="Módulo al que llamar"
                  /*
                   * `min-w` y no `max-w`: el control tiene el ancho de la
                   * opción más larga («M01 — Módulo 01 - Atención general»).
                   * Antes se limitaba a 13rem y el texto se cortaba; el ancho
                   * ya no es un problema porque la lista lo sigue, así que se
                   * deja crecer.
                   *
                   * `w-full` a pantalla completa y `sm:w-auto` desde tablet:
                   * a 320 px el ancho intrínseco desbordaría la fila
                   * (WCAG 1.4.10).
                   */
                  className="selector-propio--auto w-full sm:w-auto"
                  valor={moduloFiltro}
                  onCambiar={setModuloFiltro}
                  opciones={[
                    { valor: '', etiqueta: 'Módulo automático' },
                    ...modulos
                      .filter((m) => m.estado === 'ACTIVO')
                      .map((m) => ({ valor: m.id, etiqueta: `${m.codigo} — ${m.denominacion}` })),
                  ]}
                />
                <BotonLlamar
                  onClick={() => setConfirmandoLlamada(true)}
                  disabled={ocupado || !periodoAbierto || topeAtencion}
                  /*
                   * El `title` explica el bloqueo en el propio botón: un botón
                   * apagado sin motivo es el fallo que se quiere evitar.
                   */
                  title={
                    topeAtencion
                      ? `Tiene ${actuales.length} turnos sin cerrar (máximo ${maximoAtencion}). Finalice o cancele uno antes de llamar a otro.`
                      : undefined
                  }
                >
                  Llamar
                </BotonLlamar>
              </div>
            </div>

            {/*
              LA PROPUESTA (P5 + P11).
              Antes de apretar, el operador ve a quién va a llamar el sistema
              y POR QUÉ. Sin esto, el "Llamar" era un reflejo: la tabla de la
              cola muestra la posición por trámite (RN-014, lo que ve el
              ciudadano) y no el orden real de llamada (RN-017), así que había
              tres turnos con "posición 1" y ninguno era previsualizable.
            */}
            {/*
              SIN `!turnoLlamado`.

              Antes la previsualización se ocultaba en cuanto había un turno
              llamado, así que con la lista «En atención ahora» llena el
              operador veía la cola pero no a QUIÉN iba a llamar. La condición
              sobraba: la tarjeta de acuse («Llamando a C-183») es otra cosa y
              vive más abajo, no choca con esta.
            */}
            {propuesta?.hay_turnos && (
              <div className="mt-5 rounded-2xl border-2 border-gris-200 bg-gris-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-gris-500">
                  El sistema va a llamar a
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="text-3xl font-black text-navy-800">
                    {propuesta.codigo_turno}
                  </span>
                  <span className="text-sm text-gris-700">
                    {propuesta.denominacion_tramite}
                  </span>
                  {propuesta.prioridad && <ChipPrioridad prioridad={propuesta.prioridad} />}
                </div>
                {propuesta.razon && (
                  <p className="mt-3 text-sm text-gris-700">{propuesta.razon}</p>
                )}
                <p className="mt-2 text-xs text-gris-500">
                  Posición {propuesta.posicion_global} de {propuesta.en_espera} en la cola
                  · {propuesta.minutos_esperando} min esperando
                </p>
              </div>
            )}

            {cargando && (
              <div className="mt-3 space-y-2" aria-busy="true">
                <span className="sr-only">Buscando el siguiente turno…</span>
                <div aria-hidden="true" className="esqueleto-bloque h-4 w-64 rounded" />
                <div aria-hidden="true" className="esqueleto-bloque h-4 w-40 rounded" />
              </div>
            )}

            {!cargando && !propuesta?.hay_turnos && (
              <p className="mt-3 text-sm text-gris-500">
                {propuesta?.mensaje ?? 'No hay turnos en espera.'}
              </p>
            )}

            {/*
              ============================ COLA DE ESPERA ============

              La cola vive DENTRO de este panel, no en una tarjeta aparte.

              «Llamar» y la lista de turnos en espera son la MISMA acción con
              distinto alcance: el siguiente de la cola, o uno concreto. Al
              estar en dos bloques separados parecían cosas distintas, y por
              eso se podía pulsar «Llamar a este» en la cola sin pasar por la
              validación que sí aplica «Llamar». Ahora hay un solo lugar con
              un solo camino.
            */}
            <div className="mt-5 border-t border-gris-200 pt-4">
              <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
            Cola de espera
          </h2>
          <span className="text-xs text-gris-500">
            {cargando ? (
              <span className="esqueleto-bloque inline-block h-3 w-20 rounded align-middle" aria-hidden="true" />
            ) : (
              <>
                {colaFiltrada.length}
                {filtroTramite ? ` de ${cola.length}` : ''}{' '}
                {cola.length === 1 ? 'turno' : 'turnos'}
              </>
            )}{' '}·{' '}
            <strong className="text-gris-700">Nº de llamada</strong> y{' '}
            posición por trámite (RN-014)
            {actualizado && (
              <>
                {' · '}
                <span title="Última lectura de la cola">
                  actualizado{' '}
                  {actualizado.toLocaleTimeString('es-MX', {
                    timeZone: 'America/Mazatlan',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </>
            )}
          </span>
        </div>
        {/*
          FILTRO POR TRÁMITE.

          Un operador solo puede atender ciertos trámites (los de su módulo), y
          con 40 turnos mezclados tenía que buscar a ojo cuál era el suyo. Con
          el filtro, la primera fila de la tabla ya es un candidato real.

          Los botones llevan el número de turnos de cada trámite para que se
          vea de un golpe dónde hay trabajo, sin tener que filtrar para
          averiguarlo.

          `aria-pressed` y no un `role="tab"`: no hay paneles que se
          intercambien, es el mismo listado filtrado. Un lector de pantalla
          anuncia «Módulo, botón, activado» y funciona.
        */}
        {/*
          BUSCADOR DE PAPEL.

          Va encima de la tabla porque resuelve una duda que la tabla NO puede:
          la lista solo muestra turnos en espera, así que un papel ya tomado no
          aparece en ninguna parte. Aquí el operador teclea el código impreso
          y sabe si todavía vale.

          Se busca por CÓDIGO y no por folio: el folio se reinicia por trámite,
          así que «folio 1» existe varias veces el mismo día.

          Va FUERA del condicional de los filtros: sirve igual cuando solo hay
          un trámite en la cola, que es justo cuando más se usa.
        */}
        <details className="mt-3 rounded-xl border border-gris-200 bg-gris-50/60">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-gris-700">
            ¿Este papel ya tiene dueño?
          </summary>
          <div className="border-t border-gris-200 p-3">
            <BuscadorPapel />
          </div>
        </details>

        {cola.length > 0 && tramitesEnCola.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-gris-100 bg-gris-50/60 px-0 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-gris-500">
              Trámite
            </span>
            <button
              type="button"
              onClick={() => {
                setFiltroTramite('')
                setPaginaCola(1)
              }}
              aria-pressed={filtroTramite === ''}
              className={`etiqueta cursor-pointer transition-colors ${
                filtroTramite === ''
                  ? 'bg-navy-800 text-white'
                  : 'bg-white text-gris-700 ring-1 ring-gris-200 hover:ring-gris-500'
              }`}
            >
              Todos
              {/*
                El número iba con `opacity-70`, que sobre el navy-800 del chip
                activo o el blanco del inactivo caía a 4.14:1 (mínimo 4.5).
                En vez de translucidez, un tono explícito por estado: el texto
                hereda el color del chip y se aclara solo cuando el chip es
                oscuro.
              */}
              <span
                className={`tabular-nums ${
                  filtroTramite === ''
                    ? 'text-white/85'
                    : 'text-gris-500'
                }`}
              >
                {cola.length}
              </span>
            </button>
            {tramitesEnCola.map((t) => {
              const activo = filtroTramite === t.clave
              return (
                <button
                  key={t.clave}
                  type="button"
                  onClick={() => {
                    // Al cambiar de filtro se vuelve a la primera página: si
                    // se quedara en la 3 y el filtro deja 4 turnos, la tabla
                    // saldría vacía.
                    setFiltroTramite(activo ? '' : t.clave)
                    setPaginaCola(1)
                  }}
                  aria-pressed={activo}
                  title={t.denominacion}
                  className={`etiqueta cursor-pointer transition-colors ${
                    activo
                      ? 'bg-navy-800 text-white'
                      : 'bg-white text-gris-700 ring-1 ring-gris-200 hover:ring-gris-500'
                  }`}
                >
                  {t.clave}
                  <span
                    className={`tabular-nums ${
                      activo ? 'text-white/85' : 'text-gris-500'
                    }`}
                  >
                    {t.n}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {cargando ? (
          /* Mismo esqueleto que la tabla real: 6 columnas, 10 filas. Al llegar
             los datos no hay salto de altura. */
          <EsqueletoTabla columnas={6} filas={10} />
        ) : cola.length === 0 ? (
          <Vacio
            titulo="No hay nadie en espera"
            detalle="Los turnos emitidos y no atendidos se ordenan aquí por prioridad y fecha."
          />
        ) : (
          <div className="transicion-datos overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gris-50 text-left text-xs text-gris-700">
                <tr>
                  <th
                    className="px-3 py-2 font-medium whitespace-nowrap"
                    title="Orden real de llamada (RN-017)"
                  >
                    Llamada
                  </th>
                  <th
                    className="px-3 py-2 font-medium whitespace-nowrap"
                    title="Posición dentro de su trámite (RN-014)"
                  >
                    Pos.
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Folio</th>
                  <th className="px-3 py-2 font-medium">Trámite</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Emitido</th>
                  <th className="px-3 py-2 font-medium">Prioridad</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              {/*
                `key` por página: React reutiliza las filas si solo cambian los
                datos, y entonces la animación de barrido no se volvería a
                disparar. Al cambiar la clave, el `tbody` se remonta y la
                animación CSS corre de nuevo en cada cambio de página.
              */}
              <tbody
                key={`pagina-${paginaActual}`}
                className={`divide-y divide-gris-100 ${
                  direccion === 'derecha' ? 'barrido-derecha' : 'barrido-izquierda'
                }`}
              >
                {colaPagina.map((f) => (
                  <tr key={f.turno_id} className="hover:bg-gris-50">
                    <td className="px-3 py-2.5">
                      {/*
                        El círculo se reserva para el que decide a quién
                        se llama. «Su pos.» es un dato de apoyo: va en
                        texto plano, con el numero claro pero sin gastar
                        un círculo y un borde.
                      */}
                      <span
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                          f.posicion_global === 1
                            ? 'bg-verde-50 text-verde-600 ring-2 ring-verde-500/40'
                            : 'bg-gris-100 text-gris-700'
                        }`}
                      >
                        {f.posicion_global}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-sm tabular-nums text-gris-700">
                      {f.posicion}
                      <span className="sr-only">
                        {' '}
                        (posición dentro de su trámite)
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-bold text-navy-800">
                      {f.codigo_turno}
                    </td>
                    <td className="min-w-[9rem] px-3 py-2.5 text-gris-700">
                      {f.denominacion_tramite}
                      
                    </td>
                    <td
                      className="px-3 py-2.5 whitespace-nowrap text-xs tabular-nums text-gris-700"
                      title={formatearFechaHora(f.creado_en)}
                    >
                      {formatearSoloHora(f.creado_en)}
                    </td>
                    <td className="px-3 py-2.5">
                      <ChipPrioridad prioridad={f.prioridad} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {/*
                        REDIRIGIR (P10). Antes, la única manera de atender
                        a otro que no era el siguiente era omitir al
                        llamado: es decir, quemar el turno de ese
                        ciudadano. Aquí se llama a quien sea, y los demás
                        siguen en la cola.
                      */}
                      <div className="flex justify-end gap-1.5">
                        {/*
                          QR DEL TURNO (RF-006).

                          El lote no puede traer QR: de una emisión masiva
                          salen cientos de folios y no hay nadie delante para
                          escanearlos. El código se pide aquí, cuando el
                          ciudadano ya está en la ventanilla.

                          Va primero porque es justo lo que se hace al
                          entregar el turno al ciudadano.
                        */}
                        <button
                          type="button"
                          onClick={() => void abrirQr(f)}
                          disabled={ocupado}
                          className="boton-secundario whitespace-nowrap px-3 py-1.5 text-xs"
                          title="Mostrar el código QR de este turno para entregarlo"
                        >
                          QR
                        </button>

                        {/*
                          Un turno emitido por error (trámite equivocado)
                          no se podía cancelar: había que llamarlo y
                          cancelarlo, dejando un rastro absurdo. La base
                          sí lo permite (WAITING -> CANCELLED); faltaba
                          el botón (Nielsen H3).
                        */}
                        <button
                          type="button"
                          onClick={() => setCancelando(f)}
                          disabled={ocupado || !periodoAbierto}
                          className="rounded-lg px-2 py-1.5 text-xs font-semibold text-gris-500 transition-colors hover:bg-rojo-50 hover:text-rojo-600"
                          title="Cancelar este turno (el ciudadano verá que su turno fue cancelado)"
                        >
                          Cancelar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/*
          El paginador va dentro de la tarjeta, al pie de la tabla, para que se
          lea como parte de ella y no como una sección aparte.
        */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-gris-100 px-0 py-4">
          <p className="text-xs text-gris-500" role="status" aria-live="polite">
            {colaFiltrada.length === 0
              ? 'Sin turnos en espera'
              : `Mostrando ${(paginaActual - 1) * POR_PAGINA + 1}–${Math.min(
                  paginaActual * POR_PAGINA,
                  colaFiltrada.length,
                )} de ${colaFiltrada.length}`}
          </p>
          <Paginador
            total={colaFiltrada.length}
            pagina={paginaActual}
            porPagina={POR_PAGINA}
            onCambiar={setPaginaCola}
          />
              </div>
            </div>

            {/*
              CONFIRMACIÓN DE LA LLAMADA.

              Solo confirma: «llamaste a este». Los botones para gestionarlo
              (Repetir, Omitir, Cancelar, Iniciar atención) se han quitado de
              aquí porque ya están en «En atención ahora», justo arriba.

              Antes estaban en LOS DOS sitios, así que un turno recién llamado
              mostraba cuatro botones idénticos duplicados en la misma
              pantalla. Se conservaba la copia de arriba porque al recargar la
              página el turno seguía en `CALLED` pero este panel ya no existía:
              el panel persistente es el que garantiza que las acciones
              siempre estén disponibles. El de aquí es solo un acuse.
            */}
            {turnoLlamado && (
              <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border-2 border-azul-200 bg-azul-50 p-4">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-azul-500 text-white">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                <p className="min-w-0 flex-1 text-sm text-navy-800">
                  Llamando a{' '}
                  <strong className="font-black">{turnoLlamado.codigo_turno}</strong>
                  {' · '}
                  {turnoLlamado.denominacion_tramite}
                  {turnoLlamado.codigo_modulo ? ` · ${turnoLlamado.codigo_modulo}` : ''}
                </p>
                <p className="text-xs text-gris-700">
                  Gestiónelo en «En atención ahora», arriba.
                </p>
              </div>
            )}

          </section>
        </div>
      </div>


      {/*
        LOS RETIRADOS (RF-033).

        Cuando el titular se opone al tratamiento, el turno se cancela: el
        derecho a oponerse exige cesar, no esperar. Por eso **no está en la
        cola de espera** (esa solo trae los que esperan) y, sin esta tarjeta,
        el turno desaparecía de la pantalla sin dejar rastro: el operador no
        sabía si el ciudadano se había retirado o si el sistema lo había
        perdido.

        Aquí está el rastro, con lo que el titular escribió. No se puede
        llamar a estos turnos: están cancelados.
      */}
      {retirados.length > 0 && (
        <section className="tarjeta mb-6 overflow-hidden">
          <div className="border-b border-gris-100 px-6 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
              Retirados por el titular
            </h2>
            <p className="mt-0.5 text-xs text-gris-500">
              {retirados.length}{' '}
              {retirados.length === 1 ? 'ciudadano se opuso' : 'ciudadanos se opusieron'}{' '}
              a que se atendiera su turno. No se llamarán.
            </p>
          </div>
          <ul className="divide-y divide-gris-100">
            {retirados.map((r) => (
              <li key={r.turno_id} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-bold text-navy-800">{r.codigo_turno}</span>
                  <span className="text-sm text-gris-700">
                    {r.denominacion_tramite}
                  </span>
                  {r.codigo_modulo && (
                    <span className="text-xs text-gris-500">
                      módulo {r.codigo_modulo}
                    </span>
                  )}
                </div>
                <p className="mt-1 rounded bg-ambar-50 px-2 py-1.5 text-sm text-ambar-600">
                  «{r.consideracion}»
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}


      {/*
        LA CONFIRMACIÓN DE LA LLAMADA (RF-029).

        Llamar cambia el estado de un turno de un ciudadano. Con un solo
        clic, en una pantalla con tres filas, ese clic se puede dar sin
        querer. Aquí se ve a quién va a llamar el sistema, con su código y
        su módulo, y se explica lo que va a pasar. La llamada sale del
        botón de dentro, no del de fuera.
      */}
      {confirmandoLlamada && propuesta?.hay_turnos && (
          <Modal
            titulo="Llamar al siguiente turno"
            onCerrar={() => setConfirmandoLlamada(false)}
            ancho="max-w-md"
          >
            <div className="text-center">
              <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-azul-50 text-azul-500">
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                </svg>
              </span>

              <p className="text-2xl font-black tracking-tight text-navy-800">
                ¿Llamar al siguiente turno?
              </p>
              <p className="mx-auto mt-2 max-w-xs text-sm text-gris-700">
                Se asignará a la ventanilla actual y cambiará su estado a «En
                atención».
              </p>

              <div className="mt-4 rounded-xl bg-azul-50 px-5 py-4">
                <p className="text-3xl font-black leading-none tracking-tight text-navy-800">
                  {propuesta.codigo_turno}
                </p>
                <p className="mt-1.5 text-sm text-gris-700">
                  {propuesta.denominacion_tramite}
                </p>
                <p className="mt-2">
                  <span className="etiqueta bg-azul-50 text-azul-600">En espera</span>
                </p>
              </div>

              {propuesta.razon && (
                <p className="mt-3 text-sm text-gris-700">{propuesta.razon}</p>
              )}

              <div className="mt-5 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmandoLlamada(false)
                    void llamar()
                  }}
                  disabled={ocupado}
                  className="boton-primario w-full py-3"
                >
                  Llamar turno
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmandoLlamada(false)}
                  className="boton-secundario w-full py-3"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </Modal>
      )}

      {/*
        CIERRE DE PERIODO (Nielsen H5: prevención de errores).
        Cerrar el periodo marca como OMITIDOS todos los turnos en espera y los
        llamados, y no tiene vuelta atrás. Con un solo clic se quemaba la cola
        entera de la jornada. Ahora pide confirmación y dice exactamente
        cuántos turnos se van a perder.
      */}
      {/*
        QR DEL TURNO (RF-006).

        Se muestra en un diálogo y no en la fila de la tabla: el código
        necesita tamaño para escanearse desde un teléfono, y la tabla ya va
        apretada. Aquí se puede imprimir o dejar en pantalla para que el
        ciudadano lo escanee.
      */}
      {qrTurno && (
        <Modal titulo={`Código QR · ${qrTurno.codigo}`} onCerrar={() => setQrTurno(null)}>
          {/*
            `impresion-boleto`: al imprimir, el CSS deja visible SOLO esta
            tarjeta y oculta el resto de la página. Es el mismo mecanismo del
            boleto recién emitido, para que el papel salga igual en los dos
            casos.
          */}
          <div className="impresion-boleto space-y-4 text-center">
            <p className="text-sm text-gris-700">
              Entregue este código al ciudadano. Al escanearlo verá su turno y su
              posición en la fila.
            </p>

            {/*
              El QR con «abrir enlace» anclado en su esquina superior derecha.

              Va aquí y no en la fila de botones porque su significado es
              «abrir ESTO»: pegado al código, la relación se entiende sin
              leer nada. Es la salida de emergencia (QR borroso, impresora
              caída, ciudadano sin cámara), por eso se queda discreto y con
              nombre accesible propio.
            */}
            <div className="relative mx-auto w-fit rounded-xl bg-gris-50 p-4 no-imprimir">
              <CodigoQR valor={urlQr} tamano={240} />
              <a
                href={urlQr}
                target="_blank"
                rel="noreferrer"
                className="absolute right-2 top-2 rounded-lg bg-white/90 p-1 text-gris-700 shadow-sm transition-colors hover:bg-white hover:text-azul-600"
                aria-label="Abrir el enlace del turno en otra pestaña. Solo si el QR no sirvió."
                title="Solo si el QR no sirvió. Abre el turno en otra pestaña."
              >
                <span className="ci--external-link" aria-hidden="true" />
              </a>
            </div>

            {/* El QR que se imprime, sin el botón encima. */}
            <div className="hidden print:flex justify-center rounded-xl bg-gris-50 p-4">
              <CodigoQR valor={urlQr} tamano={240} />
            </div>

            <p className="font-mono text-2xl font-black tracking-tight text-navy-800">
              {qrTurno.codigo}
            </p>

            {/*
              COPIAR, pegado al enlace que copia. El botón va encima del texto
              y no en la fila inferior: antes había que adivinar qué copiaba.
              Ahora está donde está lo que copia.
            */}
            <div className="mx-auto w-full max-w-md">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-gris-500">
                  Enlace del turno
                </span>
                <button
                  type="button"
                  onClick={() => void copiarQr()}
                  className="rounded-lg p-1.5 text-gris-700 transition-colors hover:bg-gris-50 hover:text-azul-600"
                  aria-label="Copiar el enlace del turno"
                  title="Copiar el enlace del turno"
                >
                  <span className="andrsrxn--copy" aria-hidden="true" />
                </button>
              </div>
              <p className="break-all rounded-lg bg-gris-50 px-3 py-2 font-mono text-xs text-azul-600 no-imprimir">
                {urlQr}
              </p>
            </div>
            <p className="text-xs text-gris-500">
              No contiene datos personales: solo el número aleatorio del turno.
            </p>

            <div className="no-imprimir flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setQrTurno(null)} className="boton-secundario">
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="boton-primario whitespace-nowrap"
              >
                Imprimir QR
              </button>
            </div>

            {/*
              `role="status"`: el aviso de copiado aparece sin recargar, y un
              lector de pantalla no se enteraría de que la acción se hizo
              (WCAG 4.1.3).
            */}
            <p role="status" aria-live="polite" className="sr-only">
              {copiadoQr ? 'Enlace copiado al portapapeles' : ''}
            </p>
          </div>
        </Modal>
      )}

      {confirmandoCierre && periodoAbierto && (
        <Modal titulo="Cerrar el periodo" onCerrar={() => setConfirmandoCierre(false)}>
          <div className="space-y-4">
            <p className="text-sm text-gris-700">
              Al cerrar el periodo <strong>{formatearFecha(periodoAbierto.clave)}</strong>:
            </p>
            <ul className="space-y-2 rounded-lg bg-ambar-50 p-3 text-sm text-ambar-600">
              <li>
                <strong>{cola.length}</strong>{' '}
                {cola.length === 1 ? 'turno en espera' : 'turnos en espera'} quedarán como
                omitidos.
              </li>
              <li>
                <strong>{actuales.length}</strong>{' '}
                {actuales.length === 1 ? 'turno' : 'turnos'} en atención o llamados
                quedarán sin resolver.
              </li>
              <li>No se podrán emitir más turnos hoy.</li>
            </ul>
            <p className="text-xs text-gris-500">
              Los ciudadanos afectados verán que su turno no fue atendido y podrán
              reponerse en ventanilla.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmandoCierre(false)}
                className="boton-secundario"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmandoCierre(false)
                  void cerrar()
                }}
                disabled={ocupado}
                className="boton-peligro"
              >
                Sí, cerrar el periodo
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/*
        CANCELAR UN TURNO EN ESPERA (Nielsen H3: control del usuario).
        La base lo permite (WAITING -> CANCELLED) y el operador no tenía
        cómo: un turno emitido con el trámite equivocado obligaba a
        llamarlo y luego cancelarlo, dejando un rastro absurdo.
      */}
      {cancelando && (
        <Modal titulo={`Cancelar el turno ${cancelando.codigo_turno}`} onCerrar={() => setCancelando(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const motivo = (
                document.getElementById('motivo-turno') as HTMLTextAreaElement | null
              )?.value
              if (!motivo?.trim() || !cancelando) return
              const turno = cancelando
              void conTurno(
                () => cancelarTurno(turno.turno_id, motivo.trim()),
                `Turno ${turno.codigo_turno} cancelado.`,
              )
              setCancelando(null)
            }}
            className="space-y-4"
          >
            <p className="text-sm text-gris-700">
              Se cancela el turno <strong>{cancelando.codigo_turno}</strong> (
              {cancelando.denominacion_tramite}). El ciudadano verá:{' '}
              <em>«Su turno fue cancelado»</em>.
            </p>
            <p className="text-xs text-gris-500">
              Para un turno emitido con el trámite equivocado, esta es la forma
              correcta: no llega a llamarse y no ocupa lugar en la cola.
            </p>
            <Campo etiqueta="Motivo">
              <textarea
                id="motivo-turno"
                required
                rows={3}
                className="campo"
                placeholder="Por ejemplo: se emitió con el trámite equivocado"
              />
            </Campo>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCancelando(null)} className="boton-secundario">
                Volver
              </button>
              <button type="submit" className="boton-peligro">
                Cancelar el turno
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modalMotivo && (
        <Modal
          titulo={modalMotivo.accion === 'omitir' ? 'Omitir turno' : 'Cancelar turno'}
          onCerrar={() => setModalMotivo(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const motivo = (
                document.getElementById('motivo-turno') as HTMLTextAreaElement | null
              )?.value
              if (!motivo?.trim()) return
              const t = modalMotivo.turno
              void conTurno(
                () =>
                  modalMotivo.accion === 'omitir'
                    ? omitirTurno(t.turno_id, motivo.trim())
                    : cancelarTurno(t.turno_id, motivo.trim()),
                modalMotivo.accion === 'omitir' ? 'Turno omitido.' : 'Turno cancelado.',
              )
              setModalMotivo(null)
            }}
            className="space-y-4"
          >
            <p className="text-sm text-gris-700">
              {modalMotivo.accion === 'omitir'
                ? 'El ciudadano NO se presentó. Su turno queda como omitido y el ve: ' +
                  'Su turno no fue atendido. Acuda a ventanilla para reposición. ' +
                  'Podra reponerlo desde Historial.'
                : 'Se CANCELA la solicitud. El ciudadano ve: ' +
                  'Su turno fue cancelado. Esta accion no se puede reponer.'}
            </p>
            <p className="text-xs text-gris-500">
              El motivo queda registrado en el historial del turno (RF-012, RF-016).
              <strong className="block text-ambar-600">
                No escriba aquí el nombre ni el teléfono del ciudadano: el motivo
                queda guardado y no se puede modificar después.
              </strong>
            </p>
            <Campo etiqueta="Motivo">
              <textarea
                id="motivo-turno"
                required
                rows={3}
                className="campo"
                placeholder={
                  modalMotivo.accion === 'omitir'
                    ? 'Por ejemplo: el ciudadano no se presentó'
                    : 'Por ejemplo: el ciudadano desistió del trámite'
                }
              />
            </Campo>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setModalMotivo(null)} className="boton-secundario">
                Cancelar
              </button>
              <button
                type="submit"
                className={modalMotivo.accion === 'omitir' ? 'boton-secundario' : 'boton-peligro'}
              >
                {modalMotivo.accion === 'omitir' ? 'Omitir' : 'Cancelar turno'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/*
        El lote emitido se confirma con una notificación flotante, no con una
        tarjeta. Antes ocupaba un `<section className="tarjeta">` entero con su
        título, el total y una fila de folios, y quedaba ahí el resto de la
        jornada. Era demasiado peso para un dato que se consulta una vez.
      */}
      {loteEmitido && (
        <NotificacionLote
          total={loteEmitido.total}
          codigos={loteEmitido.turnos.map((t) => t.codigo)}
          onCerrar={() => setLoteEmitido(null)}
        />
      )}
    </>
  )
}

/**
 * Una tarjeta de cifra (la de la fila de arriba de la consola).
 *
 * La primera va en azul: es la que el operador mira de un vistazo, la que
 * cambia con cada llamada. Las demas se quedan en blanco para que la
 * jerarquia se lea sin ayuda.
 */
function TarjetaCifra({
  rotulo,
  valor,
  pie,
  icono,
  destacado = false,
}: {
  rotulo: string
  valor: string
  pie: string
  icono: 'persona' | 'lista' | 'grafico'
  destacado?: boolean
}) {
  const trazos: Record<typeof icono, ReactNode> = {
    persona: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    lista: <path d="M4 7h16M4 12h10M4 17h7" />,
    grafico: (
      <>
        <path d="M3 20h18" />
        <rect x="5" y="10" width="3.4" height="7" rx="1" />
        <rect x="10.3" y="6" width="3.4" height="11" rx="1" />
        <rect x="15.6" y="13" width="3.4" height="4" rx="1" />
      </>
    ),
  }
  return (
    /*
      Tarjeta de cifra con el estilo de tarjeta «de cristal mate».

      `--cifra-fondo` y `--cifra-grano` son las dos variables que el overlay
      necesita; se declaran aquí y no en el CSS para que la tarjeta destacada
      (azul) tenga su propio grano en vez del gris.
    */
    <div
      className="cifra"
      style={
        destacado
          ? ({ '--cifra-fondo': '#0f66d4', '--cifra-grano': '#0a4a9e' } as React.CSSProperties)
          : ({ '--cifra-fondo': '#eef3f9', '--cifra-grano': '#a8b7c9' } as React.CSSProperties)
      }
    >
      <div className="cifra-velo" />
      <div
        className={`cifra-cuerpo ${
          destacado ? 'bg-azul-600 text-white' : 'bg-white text-navy-900'
        }`}
      >
        <p
          className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${
            destacado ? 'text-azul-100' : 'text-gris-700'
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {trazos[icono]}
          </svg>
          {rotulo}
        </p>
        <p className="mt-1.5 text-3xl font-black leading-none tracking-tight">{valor}</p>
        <p className={`mt-1.5 text-xs ${destacado ? 'text-azul-100' : 'text-gris-700'}`}>
          {pie}
        </p>
      </div>
    </div>
  )
}

/**
 * Emisión masiva de turnos (migración 009).
 *
 * Dos formas de llenar el lote, que es lo que se pidió:
 *   - Repartir un total entre varios trámites (100 = 25 + 25 + 50).
 *   - Poner cuántos de cada trámite por separado.
 *
 * En ambos casos lo que viaja a la base es la misma lista de lotes, y la base
 * emite todo en una sola transacción: o salen todos, o no sale ninguno.
 */
function EmisionMasiva({
  tramites,
  lotes,
  onCambiar,
  onEmitir,
  ocupado,
}: {
  tramites: Tramite[]
  lotes: LoteTurnos[]
  onCambiar: (l: LoteTurnos[]) => void
  onEmitir: () => void
  ocupado: boolean
}) {
  /** Cómo se reparte: por cantidades sueltas o repartiendo un total. */
  const [total, setTotal] = useState('100')

  /*
   * Contador que se incrementa en cada reparto.
   *
   * Un `<input type="number">` no puede animar su contenido: el texto lo
   * dibuja el navegador, no el DOM, así que no hay nodo al que aplicarle una
   * animación. La solución es cambiar la `key` del input cuando se reparte:
   * React lo desmonta y lo monta de nuevo, y el navegador vuelve a pintar el
   * campo desde cero con la clase de animación puesta.
   *
   * Es más barato que construir un contador de cifras con spans, y para un
   * campo de formulario el remontaje no pierde nada: el valor llega por
   * `value`.
   */
  const [repartos, setRepartos] = useState(0)

  const filas = lotes.length > 0 ? lotes : tramites.slice(0, 2).map((t) => ({ tramite: t.clave, cantidad: 0 }))
  const suma = filas.reduce((n, l) => n + (Number(l.cantidad) || 0), 0)

  function cambiarCantidad(clave: string, cantidad: number) {
    const base = filas.map((l) => (l.tramite === clave ? { ...l, cantidad } : l))
    onCambiar(base)
  }

  /** Reparte el total a partes iguales y deja el sobrante en el primero. */
  function repartir(totalTexto: string) {
    const n = Math.max(0, Math.floor(Number(totalTexto) || 0))
    if (filas.length === 0) return
    const porCabeza = Math.floor(n / filas.length)
    const sobrante = n - porCabeza * filas.length
    onCambiar(
      filas.map((l, i) => ({ ...l, cantidad: porCabeza + (i === 0 ? sobrante : 0) })),
    )
    // Dispara la animación de las cifras al llegar al campo.
    setRepartos((n) => n + 1)
  }

  return (
    <div className="space-y-3">
      {/* Se elimina la segunda fila de pestañas. Antes había dos controles
          casi idénticos apilados («Un turno/Varios turnos» y «Por trámite/
          Repartir total») y no se distinguía cuál cambiaba qué. Ahora el
          reparto del total es un campo opcional DENTRO del mismo formulario,
          con su propia etiqueta, así que no compiten dos filas iguales. */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Campo etiqueta="Repartir un total (opcional)">
            <div className="flex gap-1.5">
              <input
                type="number"
                min={1}
                className="campo flex-1"
                placeholder="ej. 100"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
              <BotonRepartir
                onClick={() => repartir(total)}
                disabled={!total || Number(total) <= 0}
                className="shrink-0"
              >
                Repartir
              </BotonRepartir>
            </div>
          </Campo>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-gris-700">
        Escriba cuántos quiere de cada trámite, o un total y pulse «Repartir»
        para dividirlo en partes iguales.
      </p>

      <div className="space-y-1.5">
        {filas.map((l) => {
          const t = tramites.find((x) => x.clave === l.tramite)
          return (
            <div
              key={l.tramite}
              className="fila-reparto group flex items-center gap-2 rounded-lg px-2 py-1.5"
            >
              <label className="min-w-0 flex-1 truncate text-xs text-gris-700">
                <span className="font-semibold">{l.tramite}</span>
                {t ? ` — ${t.denominacion}` : ''}
              </label>

              {/*
                Contador − / + con el número en medio.

                Antes era un `<input type="number">` suelto, con las flechas
                nativas del navegador: en Chrome son dos triángulos de 6 px
                pegados al borde y en Firefox una columna gris distinta. No
                quedaban igual en ningún navegador y en pantalla táctil eran
                casi imposibles de acertar.

                Ahora son botones de 26 px (el mínimo cómodo para un dedo),
                con el valor como input de ancho fijo en medio.
              */}
              <div className="contador-turnos shrink-0">
                <button
                  type="button"
                  onClick={() => cambiarCantidad(l.tramite, Math.max(0, l.cantidad - 1))}
                  disabled={l.cantidad <= 0}
                  aria-label={`Restar uno a ${l.tramite}`}
                  className="contador-turnos-boton"
                >
                  <span className="contador-turnos-signo" aria-hidden="true" />
                </button>
                <input
                  /*
                   * La `key` incluye el número de repartos: al pulsar
                   * «Repartir» cambia, React vuelve a montar el campo y la
                   * clase `cifra-sube` arranca la animación de entrada.
                   *
                   * Sin `repartos` en la clave, el input solo se actualizaría
                   * de valor y no habría animación: el número aparecería de
                   * golpe.
                   */
                  key={`${l.tramite}-${repartos}`}
                  type="number"
                  min={0}
                  aria-label={`Cantidad para ${l.tramite}`}
                  className={`contador-turnos-valor ${
                    repartos > 0 && l.cantidad > 0 ? 'cifra-sube' : ''
                  }`}
                  value={l.cantidad}
                  onChange={(e) => cambiarCantidad(l.tramite, Number(e.target.value) || 0)}
                />
                <button
                  type="button"
                  onClick={() => cambiarCantidad(l.tramite, l.cantidad + 1)}
                  aria-label={`Sumar uno a ${l.tramite}`}
                  className="contador-turnos-boton"
                >
                  <span className="contador-turnos-signo contador-turnos-signo--mas" aria-hidden="true" />
                </button>
              </div>

              {/*
                Quitar del reparto. No borra el trámite del catálogo: solo lo
                saca de este lote. Por eso el icono es una papelera y no una
                «X», que sugeriría cerrar algo.
              */}
              <button
                type="button"
                onClick={() => onCambiar(filas.filter((x) => x.tramite !== l.tramite))}
                aria-label={`Sacar ${l.tramite} del reparto`}
                className="boton-quitar-reparto shrink-0"
              >
                <span className="icono-papelera" aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>

      {/*
        Añadir trámites al lote: uno a uno, o todos de golpe.

        El botón alterna entre «Añadir todos» y «Quitar todos» según si el lote
        ya está completo:

          faltan trámites → «Añadir todos»  (mete los que faltan)
          están todos     → «Quitar todos»  (vacía el lote)

        Antes, al añadir todos el botón desaparecía y no había forma de
        deshacerlo sin sacar los trámites uno por uno con la papelera. Alternar
        deja el regreso a un clic.

        El selector de trámite suelto solo se muestra mientras falte alguno: si
        ya están todos dentro, su lista estaría vacía.
      */}
      <div className="flex flex-col items-center gap-1.5">
        {tramites.length > filas.length && (
          <Selector
            etiqueta="Añadir otro trámite al reparto"
            className="w-full"
            /*
             * El valor siempre es `''`: este control es una ACCIÓN, no una
             * selección. Al elegir un trámite se añade a la lista y el campo
             * vuelve a su texto inicial, para poder añadir otro seguido.
             *
             * Por eso `onCambiar` añade y no guarda nada.
             */
            valor=""
            onCambiar={(clave) => {
              if (clave) onCambiar([...filas, { tramite: clave, cantidad: 0 }])
            }}
            opciones={[
              { valor: '', etiqueta: 'Añadir otro trámite…' },
              ...tramites
                .filter((t) => !filas.some((l) => l.tramite === t.clave))
                .map((t) => ({ valor: t.clave, etiqueta: `${t.clave} — ${t.denominacion}` })),
            ]}
          />
        )}
        {tramites.length > 0 && (
          <button
            type="button"
            onClick={() =>
              tramites.length > filas.length
                ? /* Añadir: se conservan las cantidades ya escritas y los
                     trámites nuevos entran en cero. */
                  onCambiar(
                    tramites.map((t) => {
                      const ya = filas.find((l) => l.tramite === t.clave)
                      return { tramite: t.clave, cantidad: ya ? ya.cantidad : 0 }
                    }),
                  )
                : /* Quitar: se vacía el lote entero. */
                  onCambiar([])
            }
            /*
             * `self-center` lo centra en la columna: el botón es más estrecho
             * que el selector de arriba y, alineado a la izquierda, quedaba
             * colgando de una esquina.
             */
            className={`boton-secundario self-center text-xs ${
              tramites.length > filas.length ? '' : 'boton-quitar-todos'
            }`}
          >
            {tramites.length > filas.length ? 'Añadir todos' : 'Quitar todos'}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-gris-200 pt-2.5">
        <span className="text-xs text-gris-700">Total a emitir</span>
        <span className="text-lg font-black text-navy-800">{suma}</span>
      </div>

      {/*
        Mismo componente que el botón de un turno: el efecto del boleto (el
        icono se estira y el texto se desvanece al pasar el cursor) es ya la
        señal visual de «esto emite turnos», así que también aplica al lote.
        Antes era un `boton-primario` plano y los dos botones de emisión se
        veían distintos sin motivo.
      */}
      <BotonEmitir
        onClick={onEmitir}
        disabled={ocupado || suma <= 0}
        className="w-full"
      >
        {suma > 0 ? `Emitir ${suma} turnos` : 'Emitir lote'}
      </BotonEmitir>
      <p className="text-[11px] leading-snug text-gris-500">
        Si un trámite del lote falla, no se emite ninguno: el lote es completo o no
        existe.
      </p>
    </div>
  )
}

/**
 * Aviso programado al siguiente turno (migración 009).
 *
 * El operador ve las opciones que la dependencia habilitó en `configuracion`
 * (5, 10 y 15 minutos por defecto) y elige una. Al cumplirse el plazo, al
 * ciudadano que está en esa posición de la cola le llega la notificación.
 */
export function PanelAviso({
  minutos,
  programado,
  onProgramar,
  onCancelar,
  ocupado,
  deshabilitado,
  cargando,
}: {
  minutos: number[]
  programado: { codigo: string; minutos: number } | null
  onProgramar: (m: number) => void
  onCancelar: () => void
  ocupado: boolean
  deshabilitado: boolean
  /** Mientras carga no se puede afirmar que no hay turnos a los que avisar. */
  cargando: boolean
}) {
  return (
    <section className="tarjeta p-6">
      <h2 className="text-sm font-bold uppercase tracking-wide text-gris-700">
        Avisar al siguiente
      </h2>
      {cargando ? (
        <div className="mt-3 space-y-3" aria-busy="true">
          <span className="sr-only">Cargando el aviso al siguiente turno…</span>
          <div aria-hidden="true" className="esqueleto-bloque h-3 w-full rounded" />
          <div aria-hidden="true" className="esqueleto-bloque h-3 w-4/5 rounded" />
          <div aria-hidden="true" className="mt-4 grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="esqueleto-bloque h-9 rounded-lg" />
            ))}
          </div>
        </div>
      ) : (
      <>
      <p className="mt-1 text-xs leading-snug text-gris-500">
        Elige con cuánta anticipación quiere que le llegue el aviso al turno que
        sigue en la cola.
      </p>

      {programado && (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-verde-50 px-3 py-2">
          <span className="text-xs text-navy-800">
            <span className="font-bold">{programado.codigo}</span> avisado en{' '}
            <span className="font-bold">{programado.minutos} min</span>
          </span>
          <button
            type="button"
            onClick={onCancelar}
            disabled={ocupado}
            className="text-xs font-semibold text-navy-800 underline"
          >
            Cancelar
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3">
        {minutos.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onProgramar(m)}
            disabled={ocupado || deshabilitado}
            className="boton-secundario text-sm"
          >
            {/* El nombre accesible lo da el texto del botón. Un aria-label
                distinto («Avisar en 5 minutos») rompe WCAG 2.5.3: el nombre
                debe CONTENER el texto visible, o quien dicta «5 min» por voz
                no activa nada. El contexto lo pone el título del panel. */}
            {m} min
          </button>
        ))}
      </div>

      {deshabilitado && (
        <p className="mt-2 text-[11px] leading-snug text-gris-500">
          No hay turnos en espera a los que avisar.
        </p>
      )}
      </>
      )}
    </section>
  )
}
