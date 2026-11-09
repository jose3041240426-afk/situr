/*
 * Fondo «Bloom Field»: degradado de malla estático.
 *
 * Es el degradado del diseño original, con los colores y los centros de su
 * JSON, pero SIN la animación: un fondo que se mueve debajo de una tabla que
 * hay que leer durante ocho horas es una distracción, y además obliga a
 * repintar la pantalla completa sesenta veces por segundo.
 *
 * Al no haber movimiento, esto es CSS puro: no necesita `requestAnimationFrame`,
 * ni `useEffect`, ni recalcular nada. El navegador lo pinta una vez y lo
 * compone en su propia capa. También desaparece el problema del `style`
 * reescrito por React, porque el valor es fijo.
 *
 * SI QUIERES TOCAR LOS COLORES
 * Todo lo ajustable está en `PALETA`, justo abajo. El resto del archivo no hay
 * que tocarlo.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PANEL DE AJUSTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `base` es el color del lienzo, debajo de todos los blobs. Es el que más se
 * ve en las esquinas, así que cambiarlo cambia todo el ambiente.
 *
 * Cada blob lleva:
 *   color  trío R, G, B (formato `rgba` de CSS)
 *   x, y   centro en porcentaje de la pantalla (0 = izquierda/arriba)
 *   radio  hasta dónde llega su degradado; más grande = se funde más
 *
 * El PRIMERO de la lista queda ENCIMA (así funciona `background-image`: la
 * primera capa es la superior). Por eso el blanco va primero: cubre el centro
 * con luz y los azules quedan como halos debajo, en los bordes.
 *
 * Para probar combinaciones basta cambiar valores aquí y guardar.
 *
 * Tríos de ejemplo:
 *     blanco        255, 255, 255      gris claro    226, 226, 226
 *     azul cielo     74, 201, 255      azul glaseado  27, 159, 254
 *     azul marino    13,  58, 107      turquesa       20, 184, 166
 *     menta         167, 243, 208      lavanda       196, 181, 253
 *     arena         253, 230, 200      coral         254, 178, 178
 *     verde          74, 222, 128      violeta       167, 139, 250
 */
const PALETA = {
  /** Lienzo de fondo. */
  base: '236, 244, 252',

  blobs: [
    // Luz blanca: el blob más grande y el que aclara todo el plano.
    { color: '255, 255, 255', x: 50, y: 40, radio: 130 },
    // Azul glaseado #1B9FFE — halo inferior izquierdo.
    { color: '27, 159, 254', x: 35.47, y: 88, radio: 46 },
    // Azul cielo #4AC9FF — halo inferior derecho.
    { color: '74, 201, 255', x: 88, y: 92, radio: 44 },
  ],
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FIN DEL PANEL DE AJUSTE
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Convierte un blob en una parada de `radial-gradient`.
 *
 * Se generan cinco paradas de opacidad (1 → 0) en vez de dos porque un
 * degradado de dos colores cae en línea recta y se nota el borde del círculo.
 * Con estos cinco pasos el color se disuelve, que es lo que hace que parezca
 * una malla y no un foco de linterna.
 */
function capaDe(b: { color: string; x: number; y: number; radio: number }) {
  return `radial-gradient(circle at ${b.x}% ${b.y}%, rgba(${b.color}, 1) 0%, rgba(${b.color}, 0.844) 19%, rgba(${b.color}, 0.5) 38%, rgba(${b.color}, 0.156) 57%, rgba(${b.color}, 0) ${b.radio}%)`
}

/**
 * Fondo de la aplicación.
 *
 * Va en un `div` de posición fija (`inset: 0`, `z-index: -1`) y no en el
 * `body`: así el navegador lo pinta como una capa propia y el contenido se
 * compone por encima sin repintar el fondo en cada cambio de pantalla.
 *
 * `aria-hidden` y `pointer-events: none`: es decoración pura, no debe
 * aparecer en el lector de pantalla ni recibir clics.
 */
export default function FondoBloom() {
  return (
    <div
      aria-hidden="true"
      className="fondo-bloom"
      style={{
        // Color de respaldo por si el navegador no aplica los degradados.
        backgroundColor: `rgb(${PALETA.base})`,
        backgroundImage: PALETA.blobs.map(capaDe).join(', '),
      }}
    />
  )
}
