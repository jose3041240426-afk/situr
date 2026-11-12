/**
 * SITUR — Utilidades del operador.
 *
 * El operador aparece en dos sitios a la vez: en la cabecera del panel y en
 * su ficha. Los dos necesitan el mismo nombre completo, y si cada uno lo
 * compusiera por su cuenta acabarían differing en algún detalle.
 */

/** Un operador, o lo que haga falta de él para nombrarlo. */
export interface NombreOperador {
  nombres: string
  apellidoPaterno: string | null
  apellidoMaterno: string | null
}

/**
 * El nombre completo, como se muestra: «Nombres Apellido Paterno Materno».
 *
 * Los apellidos vienen del catálogo `apellidos` y pueden faltar, así que se
 * filtra lo vacío en lugar de dejar un doble espacio en medio.
 */
export function nombreCompleto(op: NombreOperador | null): string {
  if (!op) return 'Operador'
  return [op.nombres, op.apellidoPaterno, op.apellidoMaterno]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
