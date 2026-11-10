import { EsqueletoTabla } from '../components/ui'

/**
 * Esqueletos de carga, uno por pantalla.
 *
 * POR QUÉ UNO POR PANTALLA
 * Antes había un único esqueleto para todo el panel: dos tarjetas genéricas con
 * barras de texto. En «Turnos» no se parece a nada de lo que aparece después
 * —que son una barra de periodo, tres cifras y dos columnas—, así que al llegar
 * el contenido la pantalla daba un salto: el hueco reservado no era el hueco
 * real. Un esqueleto que miente es peor que no tenerlo, porque el ojo ya está
 * leyendo una estructura que no va a existir.
 *
 * CÓMO SE ELIGE
 * Por la ruta actual, que es lo único que se sabe mientras el chunk de la
 * pantalla aún no ha llegado (cada una se carga con `lazy`).
 *
 * QUÉ SE REPITE Y QUÉ NO
 * Se repiten los contenedores reales —número de tarjetas, columnas de la tabla,
 * altura de la barra de acciones— y no el contenido: los bloques son grises a
 * propósito, para que nadie los confunda con datos.
 */

/** Ancho de las barras de cabecera: distintos para que no parezca una tabla. */
function Titulo() {
  return <div className="esqueleto-bloque h-4 w-40 rounded" />
}

export default function EsqueletoPantalla({ ruta }: { ruta: string }) {
  if (ruta.startsWith('/admin/turnos')) return <EsqueletoTurnos />
  if (ruta.startsWith('/admin/usuarios')) return <EsqueletoUsuarios />
  if (ruta.startsWith('/admin/catalogos')) return <EsqueletoCatalogos />
  if (ruta.startsWith('/admin/historial')) return <EsqueletoHistorial />
  if (ruta.startsWith('/admin/estadisticas')) return <EsqueletoEstadisticas />
  return <EsqueletoGenerico />
}

/* ---------------------------------------------------------------- Turnos -- */
/*
 * La consola real, de arriba abajo: barra del periodo, tres cifras y la rejilla
 * de dos columnas (emitir a la izquierda; en atención y cola a la derecha).
 */
function EsqueletoTurnos() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando la consola…</span>

      <div className="tarjeta p-6" aria-hidden="true">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div>
            <div className="esqueleto-bloque mb-2 h-3 w-32 rounded" />
            <div className="esqueleto-bloque h-5 w-44 rounded" />
          </div>
          <div className="esqueleto-bloque h-10 w-36 rounded-lg" />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="tarjeta p-6">
            <div className="esqueleto-bloque mb-3 h-3 w-24 rounded" />
            <div className="esqueleto-bloque mb-3 h-8 w-28 rounded" />
            <div className="esqueleto-bloque h-3 w-2/3 rounded" />
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[22rem_1fr]" aria-hidden="true">
        <div className="space-y-5">
          <div className="tarjeta p-6">
            <div className="esqueleto-bloque mb-4 h-4 w-28 rounded" />
            <div className="esqueleto-bloque mb-2 h-9 w-40 rounded-lg" />
            <div className="esqueleto-bloque mb-3 h-3 w-28 rounded" />
            <div className="esqueleto-bloque mb-4 h-10 w-full rounded-lg" />
            <div className="esqueleto-bloque h-11 w-full rounded-lg" />
          </div>
        </div>

        <div className="space-y-5">
          <div className="tarjeta overflow-hidden">
            <div className="flex items-center justify-between border-b border-gris-100 px-6 py-4">
              <div className="esqueleto-bloque h-4 w-40 rounded" />
              <div className="esqueleto-bloque h-5 w-12 rounded-full" />
            </div>
            <div className="space-y-4 px-6 py-5">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="esqueleto-bloque h-5 w-24 rounded" />
                  <div className="esqueleto-bloque h-4 w-40 rounded" />
                  <div className="ml-auto flex gap-1.5">
                    <div className="esqueleto-bloque h-8 w-8 rounded-lg" />
                    <div className="esqueleto-bloque h-8 w-8 rounded-lg" />
                    <div className="esqueleto-bloque h-8 w-28 rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="tarjeta overflow-hidden">
            <div className="flex items-center justify-between border-b border-gris-100 px-6 py-4">
              <div className="esqueleto-bloque h-4 w-36 rounded" />
              <div className="esqueleto-bloque h-9 w-28 rounded-lg" />
            </div>
            <div className="px-6 py-4">
              <div className="esqueleto-bloque mb-4 h-20 w-full rounded-xl" />
              {/*
                Siete columnas y diez filas: es exactamente la cola (llamada,
                posición, folio, trámite, emitido, prioridad y acciones), y
                diez es el tamaño de página. Un esqueleto con cinco filas
                encogía la tabla 200 px y luego la página daba un salto.
              */}
              <div aria-hidden="true">
                <EsqueletoTabla columnas={7} filas={10} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- Usuarios -- */
/*
 * Una sola tarjeta, con su cabecera y la tabla de seis columnas: empleado,
 * nombre, rol, módulo, MFA y estado.
 */
function EsqueletoUsuarios() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando los usuarios…</span>
      <section className="tarjeta overflow-hidden">
        <div className="border-b border-gris-100 px-4 py-3" aria-hidden="true">
          <Titulo />
          <div className="esqueleto-bloque mt-2 h-3 w-72 rounded" />
        </div>
        <div aria-hidden="true">
          <EsqueletoTabla columnas={6} filas={6} />
        </div>
      </section>
    </div>
  )
}

/* -------------------------------------------------------------- Catálogos -- */
/*
 * Dos tarjetas lado a lado —trámites y módulos—, cada una con cinco filas de
 * «nombre + etiqueta».
 */
function EsqueletoCatalogos() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando los catálogos…</span>
      <div className="grid gap-4 lg:grid-cols-2" aria-hidden="true">
        {Array.from({ length: 2 }).map((_, c) => (
          <section key={c} className="tarjeta overflow-hidden">
            <div className="border-b border-gris-100 px-4 py-3">
              <Titulo />
              <div className="esqueleto-bloque mt-2 h-3 w-64 rounded" />
            </div>
            <ul className="divide-y divide-gris-100">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="esqueleto-bloque mb-1.5 h-4 w-52 rounded" />
                    <div className="esqueleto-bloque h-3 w-32 rounded" />
                  </div>
                  <div className="esqueleto-bloque h-5 w-16 rounded-full" />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- Historial -- */
/*
 * Filtros arriba y debajo las tarjetas de cada turno, con su línea de tiempo.
 * Tres bastan: es lo que cabe en una pantalla y lo que se ve mientras carga.
 */
function EsqueletoHistorial() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando el historial…</span>

      <section className="tarjeta p-4" aria-hidden="true">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="esqueleto-bloque mb-1.5 h-3 w-12 rounded" />
            <div className="esqueleto-bloque h-9 w-40 rounded-lg" />
          </div>
          <div className="ml-auto flex items-end gap-2">
            <div>
              <div className="esqueleto-bloque mb-1.5 h-3 w-14 rounded" />
              <div className="esqueleto-bloque h-9 w-40 rounded-lg" />
            </div>
            <div className="esqueleto-bloque h-9 w-24 rounded-lg" />
          </div>
        </div>
      </section>

      {Array.from({ length: 3 }).map((_, i) => (
        <section key={i} className="tarjeta overflow-hidden" aria-hidden="true">
          <div className="flex items-center justify-between border-b border-gris-100 px-5 py-3.5">
            <div className="esqueleto-bloque h-6 w-20 rounded" />
            <div className="esqueleto-bloque h-5 w-24 rounded-full" />
          </div>
          <div className="space-y-4 px-5 py-4">
            {Array.from({ length: 3 }).map((_, f) => (
              <div key={f} className="flex items-start gap-3">
                <div className="esqueleto-bloque h-6 w-6 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="esqueleto-bloque mb-1.5 h-4 w-56 rounded" />
                  <div className="esqueleto-bloque h-3 w-72 rounded" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ Estadísticas -- */
/*
 * Cuatro cifras y la tabla por trámite. La tabla existe siempre (aunque esté
 * vacía), así que el esqueleto la dibuja.
 */
function EsqueletoEstadisticas() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando las estadísticas…</span>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          /*
            Las cifras reales son tarjetas con el marco grueso de `.cifra`.
            Aquí se imita con `.tarjeta` y el mismo radio: `.cifra` a secas
            sale translúcida cuando no lleva su contenido dentro, y el
            esqueleto se veía azulado en vez de blanco.
          */
          <div key={i} className="tarjeta rounded-[28px] p-6">
            <div className="esqueleto-bloque mb-3 h-3 w-20 rounded" />
            <div className="esqueleto-bloque h-9 w-16 rounded" />
          </div>
        ))}
      </div>

      <section className="tarjeta overflow-hidden">
        <div className="border-b border-gris-100 px-4 py-3" aria-hidden="true">
          <Titulo />
        </div>
        <div aria-hidden="true">
          <EsqueletoTabla columnas={6} filas={5} />
        </div>
      </section>
    </div>
  )
}

/* ---------------------------------------------------------------- Genérico -- */
/*
 * Para una ruta que no tenga esqueleto propio (la 404, o una sección nueva que
 * todavía no se ha dibujado aquí). Mantiene la forma de tarjeta para no romper
 * la página.
 */
function EsqueletoGenerico() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Cargando pantalla…</span>
      <div aria-hidden="true" className="tarjeta p-6">
        <div className="esqueleto-bloque mb-4 h-4 w-40 rounded" />
        <div className="esqueleto-bloque mb-2 h-5 w-2/3 rounded" />
        <div className="esqueleto-bloque h-5 w-1/2 rounded" />
      </div>
    </div>
  )
}
