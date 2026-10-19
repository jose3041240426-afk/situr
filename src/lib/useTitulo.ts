import { useEffect } from 'react'

/**
 * SITUR — Título de la página (WCAG 2.4.2, nivel A).
 *
 * Cada pantalla necesita un título que la distinga de las demás: en un
 * historial de pestañas o en un lector de pantalla, "SITUR · Dirección de
 * Catastro" cuatro veces no dice nada. Aquí se compone con la parte fija.
 */
const SUFIJO = 'SITUR · Dirección de Catastro'

export function useTitulo(titulo: string | null | undefined) {
  useEffect(() => {
    document.title = titulo ? `${titulo} — ${SUFIJO}` : SUFIJO
    return () => {
      document.title = SUFIJO
    }
  }, [titulo])
}
