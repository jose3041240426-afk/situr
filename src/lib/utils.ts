import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * SITUR — Utilidad de clases.
 *
 * `clsx` Une clases condicionales; `tailwind-merge` resuelve los choques de
 * Tailwind para que la última que gana sea la que manda. Sin esto, un
 * `className` que el consumidor pase no podría reemplazar una clase del
 * componente (por ejemplo, `h-10` del botón contra `h-12` de quien lo usa).
 *
 * Es la misma función que usa shadcn/ui.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
