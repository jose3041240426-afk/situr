import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Disposicion from './Disposicion'
import CodigoQR from '../components/CodigoQR'
import { Aviso, Campo, Chip, ChipEstado, ChipPrioridad, Modal, Vacio } from '../components/ui'
import {
  ErrorSitur,
  abrirPeriodo,
  cancelarTurno,
  cerrarPeriodo,
  formatearFechaHora,
  formatearSoloHora,
  finalizarTurno,
  generarTurno,
  iniciarAtencion,
  listarCola,
  listarModulos,
  listarPeriodos,
  listarTramites,
  listarTurnosActuales,
  listarTurnosRetirados,
  llamarSiguiente,
  llamarTurno,
  omitirTurno,
  proponerSiguienteTurno,
  repetirLlamada,
} from '../lib/rpc'
import type {
  FilaActual,
  FilaCola,
  FilaRetirado,
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
  const [cola, setCola] = useState<FilaCola[]>([])
  /** Turnos que el titular retiró oponiéndose (RF-033). */
  const [retirados, setRetirados] = useState<FilaRetirado[]>([])
  const [actuales, setActuales] = useState<FilaActual[]>([])
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

  // Llamada
  const [moduloFiltro, setModuloFiltro] = useState('')
  const [turnoLlamado, setTurnoLlamado] = useState<FilaActual | null>(null)
  /** La propuesta del sistema, con su razón (P5). */
  const [propuesta, setPropuesta] = useState<PropuestaSiguiente | null>(null)
  const [modalMotivo, setModalMotivo] = useState<
    { turno: FilaActual; accion: 'omitir' | 'cancelar' } | null
  >(null)
  /** Confirmación del cierre de periodo (Nielsen H5: acción destructiva). */
  const [confirmandoCierre, setConfirmandoCierre] = useState(false)
  /** Un turno en espera que el operador quiere cancelar (trámite equivocado). */
  const [cancelando, setCancelando] = useState<FilaCola | null>(null)

  const hoy = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
  }, [])

  const cargar = useCallback(async () => {
    try {
      const [ps, c, a, ts, ms, rt] = await Promise.all([
        listarPeriodos(),
        listarCola(),
        listarTurnosActuales(),
        listarTramites(),
        listarModulos(),
        listarTurnosRetirados(),
      ])
      setPeriodoAbierto(ps.find((p) => p.estado === 'ABIERTO') ?? null)
      setCola(c)
      setActuales(a)
      setRetirados(rt)
      setTramites(ts)
      setModulos(ms)
      setActualizado(new Date())
      if (!tramiteId && ts.length > 0) setTramiteId(ts[0].id)

      // La propuesta: qué va a llamar el sistema y por qué (P5 + P11).
      // Solo tiene sentido si hay un periodo abierto.
      if (ps.some((p) => p.estado === 'ABIERTO')) {
        try {
          setPropuesta(await proponerSiguienteTurno())
        } catch {
          setPropuesta(null)
        }
      } else {
        setPropuesta(null)
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
      `Periodo ${periodoAbierto.clave} cerrado. Los turnos en espera se omitieron.`,
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
  async function llamarEste(turnoId: string) {
    setOcupado(true)
    setAviso(null)
    try {
      const r = await llamarTurno(turnoId)
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
      setAviso({ tono: 'ok', texto: `${r.codigo_turno} llamado a ${r.codigo_modulo}.` })
      await cargar()
    } catch (e) {
      setAviso({
        tono: 'peligro',
        texto: e instanceof ErrorSitur ? e.message : 'No se pudo llamar a ese turno.',
      })
    } finally {
      setOcupado(false)
    }
  }

  // ------------------------------------------------------------------ pantalla

  if (!puedeOperar) {
    return (
      <Disposicion titulo="Turnos">
        <Aviso tono="alerta">
          Su cuenta no tiene permiso para operar turnos. Consulte con el administrador.
        </Aviso>
      </Disposicion>
    )
  }

  return (
    <Disposicion titulo="Turnos">
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

      {/* Barra de periodo operativo */}
      <section className="tarjeta mb-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-institucional-400">
              Periodo operativo
            </p>
            <p className="mt-0.5 flex items-center gap-2 text-lg font-bold text-institucional-800">
              {periodoAbierto ? periodoAbierto.clave : hoy}
              {periodoAbierto ? (
                <Chip tono="ok">Abierto</Chip>
              ) : (
                <Chip tono="peligro">Cerrado</Chip>
              )}
            </p>
            {periodoAbierto?.hora_inicio && (
              <p className="text-xs text-institucional-400">
                Abierto a las {formatearSoloHora(periodoAbierto.hora_inicio)}
              </p>
            )}
          </div>
          {periodoAbierto ? (
            <button
              type="button"
              onClick={() => setConfirmandoCierre(true)}
              disabled={ocupado}
              className="boton-secundario whitespace-nowrap px-3 py-1.5 text-xs"
            >
              Cerrar periodo
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void abrir()}
              disabled={ocupado}
              className="boton-primario"
            >
              Abrir periodo de hoy
            </button>
          )}
        </div>
      </section>

      {aviso && (
        /*
         * `role="status"`: el aviso aparece y desaparece sin que recargue la
         * página, así que un lector de pantalla no se enteraría de que la
         * operación se hizo (WCAG 4.1.3, nivel AA).
         */
        <div role="status" aria-live="polite" className="mb-4">
          <Aviso tono={aviso.tono}>{aviso.texto}</Aviso>
        </div>
      )}

      {/* `min-w-0` en los hijos: sin eso, un hijo de la rejilla no baja del
          ancho de su contenido (un <select> con opciones largas) y la pagina
          desborda en horizontal a 320 px (WCAG 1.4.10). */}
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        {/* ------------------------------------------------ emitir turno */}
        <div className="min-w-0 space-y-4">
          <section className="tarjeta p-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
              Emitir turno
            </h2>

            {!periodoAbierto ? (
              <p className="mt-3 rounded-lg bg-alerta-50 px-3 py-2.5 text-sm text-alerta-700">
                No hay periodo abierto. Sin él, la base rechaza cualquier alta de turno
                (RF-025).
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <Campo etiqueta="Trámite">
                  <select
                    className="selector"
                    value={tramiteId}
                    onChange={(e) => setTramiteId(e.target.value)}
                  >
                    {tramites.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.clave} — {t.denominacion}
                      </option>
                    ))}
                  </select>
                </Campo>

                <Campo etiqueta="Prioridad" ayuda="RN-017: URGENTE sale antes que el resto.">
                  <select
                    className="selector"
                    value={prioridad}
                    onChange={(e) => setPrioridad(e.target.value as typeof prioridad)}
                  >
                    <option value="NORMAL">Normal</option>
                    <option value="PREFERENTE">Preferente</option>
                    <option value="URGENTE">Urgente</option>
                  </select>
                </Campo>

                <button
                  type="button"
                  onClick={() => void emitir()}
                  disabled={ocupado || !tramiteId}
                  className="boton-primario w-full"
                >
                  Emitir turno
                </button>
              </div>
            )}
          </section>

          {emitido && (
            <section className="tarjeta p-4 impresion-boleto">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
                    Turno emitido
                  </h2>
                  <p className="mt-1 text-2xl font-black text-institucional-800">
                    {emitido.codigo}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEmitido(null)}
                  className="no-imprimir rounded-lg p-1 text-institucional-300 hover:bg-institucional-50"
                  aria-label="Cerrar"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="mt-3 flex flex-col items-center">
                <CodigoQR valor={`${window.location.origin}/turno/${emitido.token}`} />
                <p className="mt-2 max-w-[15rem] break-all text-center font-mono text-[10px] text-institucional-300">
                  {emitido.token}
                </p>
              </div>

              {/*
                El token impreso en el boleto es la credencial del
                ciudadano: con el cualquiera puede ver su turno. Por eso
                el QR va con una nota que lo dice.
              */}
              <p className="mx-auto mt-3 max-w-[15rem] text-[10px] leading-relaxed text-institucional-400">
                Este código es la credencial de su turno: no lo comparta ni
                lo muestre en público.
              </p>

              <div className="no-imprimir mt-3 flex gap-2">
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

          {/* Módulos */}
          <section className="tarjeta p-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
              Módulos
            </h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {modulos.map((m) => (
                <Chip key={m.id} tono={m.estado === 'ACTIVO' ? 'ok' : 'neutro'}>
                  {m.codigo}
                  {m.estado !== 'ACTIVO' ? ` · ${m.estado === 'PAUSADO' ? 'Pausado' : 'Fuera'}` : ''}
                </Chip>
              ))}
            </div>
            {operador?.modulo && (
              <p className="mt-2 text-xs text-institucional-400">
                Su módulo: <strong>{operador.modulo}</strong>. Si está activo, «llamar
                siguiente» enruta ahí (RG-004).
              </p>
            )}
          </section>
        </div>

        {/* ------------------------------------------------ atención */}
        <div className="min-w-0 space-y-4">
          <section className="tarjeta p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
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
                <select
                  aria-label="Módulo al que llamar"
                  className="selector w-full min-w-0 max-w-[13rem] py-2 text-sm sm:w-auto"
                  value={moduloFiltro}
                  onChange={(e) => setModuloFiltro(e.target.value)}
                >
                  <option value="">Módulo automático</option>
                  {modulos
                    .filter((m) => m.estado === 'ACTIVO')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.codigo} — {m.denominacion}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={() => void llamar()}
                  disabled={ocupado || !periodoAbierto}
                  className="boton-primario px-6 py-3 text-base"
                >
                  Llamar
                </button>
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
            {propuesta?.hay_turnos && !turnoLlamado && (
              <div className="mt-4 rounded-xl border-2 border-institucional-200 bg-institucional-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-institucional-400">
                  El sistema va a llamar a
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <span className="text-3xl font-black text-institucional-800">
                    {propuesta.codigo_turno}
                  </span>
                  <span className="text-sm text-institucional-600">
                    {propuesta.denominacion_tramite}
                  </span>
                  {propuesta.prioridad && <ChipPrioridad prioridad={propuesta.prioridad} />}
                </div>
                {propuesta.razon && (
                  <p className="mt-2 text-sm text-institucional-600">{propuesta.razon}</p>
                )}
                <p className="mt-1 text-xs text-institucional-400">
                  Posición {propuesta.posicion_global} de {propuesta.en_espera} en la cola
                  · {propuesta.minutos_esperando} min esperando
                </p>
              </div>
            )}

            {!propuesta?.hay_turnos && !turnoLlamado && (
              <p className="mt-3 text-sm text-institucional-400">
                {propuesta?.mensaje ?? 'No hay turnos en espera.'}
              </p>
            )}

            {turnoLlamado && (
              <div className="mt-4 rounded-xl border-2 border-institucional-200 bg-institucional-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-3xl font-black text-institucional-800">
                      {turnoLlamado.codigo_turno}
                    </p>
                    <p className="text-sm text-institucional-600">
                      {turnoLlamado.denominacion_tramite} · {turnoLlamado.codigo_modulo}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void conTurno(
                          () => repetirLlamada(turnoLlamado.turno_id),
                          'Llamada repetida.',
                        )
                      }
                      disabled={ocupado}
                      className="boton-secundario"
                    >
                      Repetir
                    </button>
                    {/*
                      OMITIR y CANCELAR no son sinonimos, y el ciudadano ve
                      mensajes distintos segun cual se elija:
                        · OMITIR   -> "Su turno no fue atendido. Acuda a
                          ventanilla para reposicion." (no se presento)
                        · CANCELAR -> "Su turno fue cancelado." (se cancela
                          la solicitud)
                      Con los dos botones igual de rotulados, el operador
                      elegia al azar (Nielsen H2 y H6). Ahora cada uno dice lo
                      que hace y el dialogo explica el efecto.
                    */}
                    <button
                      type="button"
                      onClick={() =>
                        setModalMotivo({ turno: turnoLlamado, accion: 'omitir' })
                      }
                      disabled={ocupado}
                      className="boton-secundario"
                      title="El ciudadano no se presento. Podra reponerse en ventanilla."
                    >
                      Omitir
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setModalMotivo({ turno: turnoLlamado, accion: 'cancelar' })
                      }
                      disabled={ocupado}
                      className="boton-peligro"
                      title="Se cancela la solicitud del ciudadano. No se puede reponer."
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void conTurno(
                          () => iniciarAtencion(turnoLlamado.turno_id),
                          'Atención iniciada.',
                        )
                      }
                      disabled={ocupado}
                      className="boton-primario"
                    >
                      Iniciar atención
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* En atención ahora */}
          <section className="tarjeta overflow-hidden">
            <div className="border-b border-institucional-100 px-4 py-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
                En atención ahora
              </h2>
            </div>
            {actuales.length === 0 ? (
              <Vacio titulo="No hay turnos en curso" detalle="Los turnos llamados y en atención aparecen aquí." />
            ) : (
              <ul className="divide-y divide-institucional-100">
                {actuales.map((t) => (
                  <li key={t.turno_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold text-institucional-800">
                          {t.codigo_turno}
                        </span>
                        <ChipEstado estado={t.estado} />
                        <ChipPrioridad prioridad={t.prioridad} />
                      </div>
                      <p className="truncate text-xs text-institucional-400">
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
                            className="boton-primario px-3 py-1.5 text-xs"
                          >
                            Atender
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
        <section className="tarjeta mb-4 overflow-hidden">
          <div className="border-b border-institucional-100 px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
              Retirados por el titular
            </h2>
            <p className="mt-0.5 text-xs text-institucional-400">
              {retirados.length}{' '}
              {retirados.length === 1 ? 'ciudadano se opuso' : 'ciudadanos se opusieron'}{' '}
              a que se atendiera su turno. No se llamarán.
            </p>
          </div>
          <ul className="divide-y divide-institucional-100">
            {retirados.map((r) => (
              <li key={r.turno_id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-bold text-institucional-800">{r.codigo_turno}</span>
                  <span className="text-sm text-institucional-600">
                    {r.denominacion_tramite}
                  </span>
                  {r.codigo_modulo && (
                    <span className="text-xs text-institucional-400">
                      módulo {r.codigo_modulo}
                    </span>
                  )}
                </div>
                <p className="mt-1 rounded bg-alerta-50 px-2 py-1.5 text-sm text-alerta-700">
                  «{r.consideracion}»
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Cola de espera */}
      <section className="tarjeta overflow-hidden">
        <div className="flex items-center justify-between border-b border-institucional-100 px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-institucional-500">
            Cola de espera
          </h2>
          <span className="text-xs text-institucional-400">
            {cola.length} {cola.length === 1 ? 'turno' : 'turnos'} ·{' '}
            <strong className="text-institucional-600">Nº de llamada</strong> y{' '}
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
        {cargando ? (
          <Vacio titulo="Cargando…" />
        ) : cola.length === 0 ? (
          <Vacio
            titulo="No hay nadie en espera"
            detalle="Los turnos emitidos y no atendidos se ordenan aquí por prioridad y fecha."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-institucional-50 text-left text-xs text-institucional-500">
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
              <tbody className="divide-y divide-institucional-100">
                {cola.map((f) => (
                  <tr key={f.turno_id} className="hover:bg-institucional-50">
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
                            ? 'bg-ok-50 text-ok-700 ring-2 ring-ok-500/40'
                            : 'bg-institucional-100 text-institucional-700'
                        }`}
                      >
                        {f.posicion_global}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-sm tabular-nums text-institucional-500">
                      {f.posicion}
                      <span className="sr-only">
                        {' '}
                        (posición dentro de su trámite)
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-bold text-institucional-800">
                      {f.codigo_turno}
                    </td>
                    <td className="min-w-[9rem] px-3 py-2.5 text-institucional-600">
                      {f.denominacion_tramite}
                      
                    </td>
                    <td
                      className="px-3 py-2.5 whitespace-nowrap text-xs tabular-nums text-institucional-500"
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
                        <button
                          type="button"
                          onClick={() => void llamarEste(f.turno_id)}
                          disabled={ocupado || !periodoAbierto}
                          className="boton-secundario whitespace-nowrap px-3 py-1.5 text-xs"
                        >
                          Llamar a este
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
                          className="rounded-lg px-2 py-1.5 text-xs font-semibold text-institucional-400 transition-colors hover:bg-peligro-50 hover:text-peligro-700"
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
      </section>

      {/*
        CIERRE DE PERIODO (Nielsen H5: prevención de errores).
        Cerrar el periodo marca como OMITIDOS todos los turnos en espera y los
        llamados, y no tiene vuelta atrás. Con un solo clic se quemaba la cola
        entera de la jornada. Ahora pide confirmación y dice exactamente
        cuántos turnos se van a perder.
      */}
      {confirmandoCierre && periodoAbierto && (
        <Modal titulo="Cerrar el periodo" onCerrar={() => setConfirmandoCierre(false)}>
          <div className="space-y-4">
            <p className="text-sm text-institucional-600">
              Al cerrar el periodo <strong>{periodoAbierto.clave}</strong>:
            </p>
            <ul className="space-y-2 rounded-lg bg-alerta-50 p-3 text-sm text-alerta-700">
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
            <p className="text-xs text-institucional-400">
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
            <p className="text-sm text-institucional-600">
              Se cancela el turno <strong>{cancelando.codigo_turno}</strong> (
              {cancelando.denominacion_tramite}). El ciudadano verá:{' '}
              <em>«Su turno fue cancelado»</em>.
            </p>
            <p className="text-xs text-institucional-400">
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
            <p className="text-sm text-institucional-600">
              {modalMotivo.accion === 'omitir'
                ? 'El ciudadano NO se presentó. Su turno queda como omitido y el ve: ' +
                  'Su turno no fue atendido. Acuda a ventanilla para reposición. ' +
                  'Podra reponerlo desde Historial.'
                : 'Se CANCELA la solicitud. El ciudadano ve: ' +
                  'Su turno fue cancelado. Esta accion no se puede reponer.'}
            </p>
            <p className="text-xs text-institucional-400">
              El motivo queda registrado en el historial del turno (RF-012, RF-016).
              <strong className="block text-alerta-700">
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
    </Disposicion>
  )
}
