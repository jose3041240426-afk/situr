/*
 * Selector de página numerado, para partir la cola de espera en tramos.
 *
 * PORTADO A TAILWIND
 * El diseño llegó hecho con styled-components, que este proyecto no usa. Aquí
 * se reproducen los tres gestos que le dan carácter:
 *   - el recuadro cuadrado que crece y se tiñe al pasar el cursor,
 *   - el punto que aparece debajo del número elegido,
 *   - el bloque de color que sube por detrás al quedar elegido.
 *
 * SE CONSTRUYE SOBRE `input type="radio"`
 * Así el teclado funciona sin código extra: las flechas ← y → cambian de
 * página y el grupo se anuncia como un solo control, que es lo que espera un
 * lector de pantalla para un paginador (WCAG 4.1.2). Con botones hermanos
 * habría que gestionar el foco a mano.
 *
 * NOMBRE ACCESIBLE
 * El nombre va en el `aria-label` del `input`, no en un `<span>` escondido
 * dentro de la etiqueta. Un span con `sr-only` hereda el `color` del `label`
 * —que en la página activa es blanco— y los analizadores de contraste miden
 * ese color heredado aunque el texto esté recortado, de modo que marcaban un
 * fallo de contraste sobre un texto que nadie puede llegar a ver. Con
 * `aria-label` no hay texto que medir y el nombre accesible sigue siendo
 * completo.
 */
export default function Paginador({
  total,
  pagina,
  porPagina,
  onCambiar,
}: {
  total: number
  pagina: number
  porPagina: number
  onCambiar: (p: number) => void
}) {
  const paginas = Math.max(1, Math.ceil(total / porPagina))
  if (paginas <= 1) return null

  return (
    <nav className="paginador" aria-label="Páginas de la cola de espera">
      {Array.from({ length: paginas }, (_, i) => {
        const n = i + 1
        const desde = i * porPagina + 1
        const hasta = Math.min((i + 1) * porPagina, total)
        return (
          <div className="paginador-grupo" key={n}>
            <input
              type="radio"
              id={`cola-pagina-${n}`}
              name="cola-pagina"
              className="sr-only"
              aria-label={`Página ${n} de ${paginas}, turnos ${desde} hasta ${hasta}`}
              checked={pagina === n}
              onChange={() => onCambiar(n)}
            />
            <label htmlFor={`cola-pagina-${n}`}>
              <span aria-hidden="true">{n}</span>
            </label>
          </div>
        )
      })}
    </nav>
  )
}
