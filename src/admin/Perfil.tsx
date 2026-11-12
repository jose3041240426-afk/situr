import { useEffect, useState } from 'react'
import { useAuth, leerNivelAal } from '../lib/auth'
import { nombreCompleto } from '../lib/operador'
import { listarFactores } from '../lib/mfa'
import { Avatar } from '../components/ui/avatar'
import { Aviso, Chip } from '../components/ui'
import GestionMfa from './GestionMfa'

/**
 * SITUR — Perfil del operador.
 *
 * La ficha de la cuenta con la que se ha entrado: quién es, qué rango tiene
 * y en qué módulo opera. Es de solo lectura a propósito.
 *
 * POR QUÉ NO HAY FOTO
 *
 * El sistema no guarda imágenes de las personas. El mismo motivo por el que
 * el ciudadano no deja ningún dato: lo que se guarda es lo que hace falta
 * para operar un turno, nada más. En su lugar se dibuja un **avatar
 * generado** a partir del nombre (ver `components/ui/avatar.tsx`): la misma
 * cuenta muestra siempre el mismo rostro y no hay nada que subir, almacenar
 * ni pedir permission.
 *
 * POR QUÉ ES DE SOLO LECTURA
 *
 * El alta la hace un administrador y el rol vive en la base (RF-001, RF-003).
 * Que el operador pueda editar su propio rango sería abrir una puerta por
 * la que cualquiera se da permisos. Lo que sí se puede cambiar —la clave— lo
 * hace la Dirección de Catastro, no esta pantalla: el sistema es clasificado
 * y no manda credenciales por correo.
 */

/** Qué puede hacer cada rango. Es la traducción de la clave del rol. */
const ALCANCE_ROL: Record<string, string[]> = {
  ADMINISTRADOR: [
    'Emitir y llamar turnos',
    'Cerrar y abrir el periodo operativo',
    'Administrar usuarios y catálogos',
    'Ver el historial completo y la auditoría',
  ],
  SUPERVISOR: [
    'Emitir y llamar turnos',
    'Consultar el historial y las estadísticas',
    'Supervisar el trabajo de los agentes',
  ],
  AGENTE: [
    'Emitir y llamar turnos',
    'Atender y cerrar su propio turno',
    'Consultar el historial y las estadísticas',
  ],
}

/** El rango que se muestra cuando el rol no está en la lista. */
const ALCANCE_POR_DEFECTO = ['Emitir y llamar turnos']

function fechaCorta(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

/** Una fila de dato: la etiqueta a la izquierda, el valor a la derecha. */
function Dato({
  etiqueta,
  valor,
  mono,
}: {
  etiqueta: string
  valor: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-gris-100 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-gris-500">
        {etiqueta}
      </dt>
      <dd
        className={
          mono
            ? 'min-w-0 break-all text-right font-mono text-xs text-navy-800'
            : 'min-w-0 text-right text-sm font-semibold text-navy-800'
        }
      >
        {valor}
      </dd>
    </div>
  )
}

export default function Perfil() {
  const { operador, sesion, esAdministrador } = useAuth()
  /*
   * El estado real del segundo factor.
   *
   * `usuarios.mfa_habilitado` dice lo que la base tiene apuntado, pero la
   * verdad de los factores está en Supabase Auth: puede que alguien haya
   * borrado el factor desde fuera y la ficha siga diciendo que lo hay. Para
   * decidir si el botón es «configurar» o «cambiar», se pregunta a la fuente.
   */
  const [hayFactor, setHayFactor] = useState(false)

  useEffect(() => {
    let vivo = true
    void listarFactores()
      .then((factores) => {
        if (vivo) setHayFactor(factores.some((f) => f.verificado))
      })
      .catch(() => {
        /* si no se puede leer, se deja el valor de la ficha */
      })
    return () => {
      vivo = false
    }
  }, [])

  if (!operador) {
    return (
      <Aviso tono="peligro">
        No se pudo leer la cuenta del operador. Vuelva a entrar.
      </Aviso>
    )
  }

  const completo = nombreCompleto(operador)
  const alcance = ALCANCE_ROL[operador.rol] ?? ALCANCE_POR_DEFECTO
  const aal = leerNivelAal(sesion?.access_token)
  const sesionFuerte = aal === 'aal2'

  return (
    <>
      {/*
        La cabecera de la ficha.

        El avatar va con `shape-image` en vez de una imagen: es un SVG que se
        dibuja en el navegador a partir del nombre, así que no hay archivo
        que cargar ni que pueda fallar.
      */}
      <section className="tarjeta mb-4 overflow-hidden">
        <div className="flex flex-col items-center gap-4 px-5 py-6 text-center sm:flex-row sm:items-center sm:gap-5 sm:py-7 sm:text-left">
          <Avatar nombre={completo} tamano="2xl" etiqueta={`Avatar de ${completo}`} />

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-2xl font-black tracking-tight text-navy-800">
              {completo}
            </h2>
            <p className="mt-0.5 text-sm font-semibold text-azul-600">
              {operador.rolNombre}
            </p>
            <p className="mt-0.5 text-xs text-gris-500">
              Dirección de Catastro · Municipio de Durango
              {operador.modulo ? ` · Módulo ${operador.modulo}` : ''}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              {operador.activo ? (
                <Chip tono="ok">Cuenta activa</Chip>
              ) : (
                <Chip tono="peligro">Cuenta desactivada</Chip>
              )}
              {operador.mfaHabilitado ? (
                <Chip tono="ok">Segundo factor verificado</Chip>
              ) : (
                <Chip tono="alerta">Segundo factor pendiente</Chip>
              )}
            </div>
          </div>
        </div>

        {/*
          La nota sobre el avatar.

          Sin esto, el operador puede pensar que es una foto que se toman sin
          avisar. La explicación va justo debajo, donde se ve.
        */}
        <p className="border-t border-gris-100 bg-gris-50 px-5 py-2.5 text-xs text-gris-500">
          El rostro de arriba <strong className="font-semibold text-gris-700">
            no es una fotografía
          </strong>
          : se dibuja en el navegador a partir de su nombre, siempre igual. El
          sistema no guarda imágenes de las personas.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- La cuenta ---- */}
        <section className="tarjeta overflow-hidden">
          <div className="border-b border-gris-100 px-4 py-3">
            <h3 className="text-sm font-bold uppercase tracking-wide text-gris-700">
              La cuenta
            </h3>
            <p className="mt-0.5 text-xs text-gris-500">
              Los datos con los que se dio de alta la cuenta.
            </p>
          </div>
          <dl className="px-4 py-2">
            <Dato etiqueta="Nombre" valor={operador.nombres} />
            <Dato
              etiqueta="Apellidos"
              valor={
                [operador.apellidoPaterno, operador.apellidoMaterno]
                  .filter(Boolean)
                  .join(' ') || '—'
              }
            />
            <Dato etiqueta="Correo" valor={operador.email} mono />
            <Dato etiqueta="Número de empleado" valor={operador.numero_empleado} mono />
            <Dato
              etiqueta="Módulo"
              valor={
                operador.modulo
                  ? `${operador.modulo}${operador.moduloNombre ? ` — ${operador.moduloNombre}` : ''}`
                  : 'Sin módulo asignado'
              }
            />
            <Dato etiqueta="Alta de la cuenta" valor={fechaCorta(operador.creadoEn)} />
            <Dato etiqueta="Última modificación" valor={fechaCorta(operador.actualizadoEn)} />
          </dl>
        </section>

        {/* ---- Rango ---- */}
        <section className="tarjeta overflow-hidden">
          <div className="border-b border-gris-100 px-4 py-3">
            <h3 className="text-sm font-bold uppercase tracking-wide text-gris-700">
              Rango
            </h3>
            <p className="mt-0.5 text-xs text-gris-500">
              Lo que este rango puede hacer. El rango lo tiene la base, no la
              pantalla: por eso aquí solo se muestra.
            </p>
          </div>
          <div className="px-4 py-4">
            <div className="flex items-center gap-2">
              <span className="text-lg font-black tracking-tight text-navy-800">
                {operador.rolNombre}
              </span>
              <span className="rounded-md bg-gris-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-gris-700">
                {operador.rol}
              </span>
            </div>
            {operador.rolDescripcion && (
              <p className="mt-1.5 text-sm text-gris-700">{operador.rolDescripcion}</p>
            )}
            <ul className="mt-3 space-y-1.5">
              {alcance.map((a) => (
                <li key={a} className="flex items-start gap-2 text-sm text-gris-700">
                  <span
                    className="mt-1.5 size-1.5 shrink-0 rounded-full bg-azul-500"
                    aria-hidden="true"
                  />
                  {a}
                </li>
              ))}
            </ul>
            {!esAdministrador && (
              <p className="mt-3 border-t border-gris-100 pt-3 text-xs text-gris-500">
                Este rango no da acceso a la gestión de usuarios ni a los
                catálogos.
              </p>
            )}
          </div>
        </section>

        {/* ---- Seguridad ---- */}
        <section className="tarjeta overflow-hidden lg:col-span-2">
          <div className="border-b border-gris-100 px-4 py-3">
            <h3 className="text-sm font-bold uppercase tracking-wide text-gris-700">
              Seguridad
            </h3>
            <p className="mt-0.5 text-xs text-gris-500">
              Cómo está protegida esta cuenta.
            </p>
          </div>
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${
                    operador.mfaHabilitado ? 'bg-verde-500' : 'bg-ambar-500'
                  }`}
                  aria-hidden="true"
                />
                <p className="text-sm font-semibold text-navy-800">
                  Segundo factor (MFA)
                </p>
              </div>
              <p className="mt-1 text-sm text-gris-700">
                {operador.mfaHabilitado
                  ? 'Verificado. En cada entrada hay que escribir el código de seis dígitos de la aplicación autenticadora.'
                  : 'Sin inscribir. La cuenta se puede entrar solo con la contraseña.'}
              </p>
              <div className="mt-3">
                <GestionMfa hayFactor={hayFactor} onCambio={() => setHayFactor(true)} />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${
                    sesionFuerte ? 'bg-verde-500' : 'bg-ambar-500'
                  }`}
                  aria-hidden="true"
                />
                <p className="text-sm font-semibold text-navy-800">
                  Sesión actual
                </p>
              </div>
              <p className="mt-1 text-sm text-gris-700">
                {sesionFuerte
                  ? 'De dos factores: contraseña más el código de verificación.'
                  : 'De un solo factor: solo la contraseña. Se cierra al salir.'}
              </p>
            </div>
          </div>
        </section>
      </div>

      {!operador.mfaHabilitado && (
        <div className="mt-4">
          <Aviso tono="alerta">
            <p className="font-bold">Esta cuenta todavía no tiene segundo factor</p>
            <p className="mt-1 font-normal">
              El acceso se valida solo con la contraseña. Puede inscribirlo
              ahora con el botón «Configurar el segundo factor», de arriba: es
              el mismo proceso que el del primer acceso.
            </p>
          </Aviso>
        </div>
      )}
    </>
  )
}
