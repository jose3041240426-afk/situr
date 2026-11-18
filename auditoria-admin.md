# Auditoría de diseño — Consola de Administración (SITUR)

Aplicando los principios de `gemini-frontend-design` (DemoLab) a `src/admin/Consola.tsx`
y comparando con los cambios ya hechos en los roles Agente y Recepción.

## 1. Dirección visual
- **Actual**: dashboard denso, muchas secciones en `BloqueExpandible`, paleta gris/azul/marino, tipografía del sistema.
- **Hallazgo**: la dirección visual es coherente (navy + azul) pero la densidad es alta. El skill pide "sustained ambition below the fold" y evitar "three-column card rows"; la Consola usa tarjetas anidadas en varios niveles.
- **Recomendación**: mantener la paleta (es la identidad del sistema). Reducir anidación de tarjetas (card-in-card) en la sección de ventanillas/turnos; usar divisores de 1px y whitespace.

## 2. Apertura (above the fold)
- **Actual**: abre con cifras del período + periodo operativo + cola. Es un dashboard, no una landing.
- **Hallazgo (skill)**: dashboards/console deben abrir directo al contenido vivo, sin hero banner. ✅ Cumple: no hay hero de marketing. Bien.
- **Pero**: hay bloques expandibles que ocultan el contenido vivo detrás de acordeones. El skill prefiere contenido directo.
- **Recomendación**: la cola "En atención ahora" y "Siguiente a llamar" deben verse sin expandir.

## 3. Tipografía
- **Actual**: múltiples tamaños (10px labels uppercase tracked, 12, 13, 14, 15, 18, 20, 24). El skill pide ≤3 tamaños en body (4 si dashboard denso).
- **Hallazgo**: se excede. Hay micro-labels de 10px tracked-out (prohibido por el skill: "avoid tracked-out ALL CAPS micro-labels").
- **Recomendación**: consolidar a 3 escalas (título, cuerpo, caption) y convertir los labels uppercase de 10px a sentence case a 12px.

## 4. Clutter de UI (chips/badges)
- **Actual**: `ChipEstado`, `ChipPrioridad` (ya quitado), `BadgePequeno`, badges de "LIVE"/estado. El skill prohíbe chips decorativos no interactivos encima de headings o dentro de cards.
- **Hallazgo**: algunos badges son semánticos (estado del turno) → OK. Pero los chips de prioridad ya se eliminaron. Revisar `BadgePequeno` en tarjetas de período.
- **Recomendación**: mantener solo badges semánticos (estado). Eliminar decorativos.

## 5. CTAs
- **Actual**: por turno hay varios botones (llamar, finalizar, omitir, cancelar, reloj, repetir). El skill pide "at most one primary CTA per content section" y "non-button controls for mode/filter choices".
- **Hallazgo**: en la fila de un turno hay 3-4 botones. Aceptable para una consola operativa (no es marketing), pero podría agruparse.
- **Recomendación**: mantener los botones de acción por turno (es herramienta operativa), pero agrupar secundarios en un menú "..." para reducir ruido visual.

## 6. Motion
- **Actual**: `entrada-escalonada` (opacity + translateY 6px, 260ms) en contenedores. `prefers-reduced-motion` respetado. ✅
- **Hallazgo**: las transiciones en botones usan `transition-colors`, `transition-transform` (específico). ✅ Cumple "never transition: all".
- **Recomendación**: mantener.

## 7. Responsividad / overflow
- **Actual**: dashboard con tablas y columnas; riesgo de overflow horizontal en móvil. El skill pide verificar 390x844.
- **Recomendación**: verificar; la Consola es desktop-first (operador en PC), aceptable, pero las tablas deben hacer scroll horizontal controlado.

## 8. Accesibilidad (a11y)
- **Actual**: botones con `aria-label`, `title`. ✅
- **Recomendación**: asegurar contraste AA (4.5:1) en texto muted (gris-500 sobre blanco ~4.6, ok). Verificar focus-visible en todos los botones (skill pide focus ring).

## 9. Features solicitadas (pendientes de implementar)
1. **Distribución de turnos**: vista resumen (turnos por ventanilla, por trámite, por estado). Actualmente la Consola lista turnos pero sin agregación visual.
2. **Acceso a pantalla en vivo**: añadir enlace/botón a `TurnosVivos` (ruta `/turnos-vivos` o similar).
3. **Eliminar/mover turnos**: `cancelarTurno` y transferencia ya existen; falta exponer "mover a otra ventanilla" (transferencia) y "eliminar" de forma clara en la fila del turno en Consola (ya existe omitir/finalizar).
4. **Restricción de trámites por ventanilla**: backend listo (mig 55-56). Falta UI de configuración en Consola.

## 10. "Mantener el toque"
- Conservar la paleta navy/azul, el `Aviso` (ahora AlertBanner en otros roles), y la densidad operativa. No convertir en marketing site. El skill se adapta al formato: dashboard = contenido directo, sin hero.

## Prioridad de implementación sugerida
1. Acceso a pantalla en vivo (1 línea, alto valor).
2. UI de configuración de trámites por ventanilla (modal con checkboxes).
3. Vista de distribución (tarjetas de resumen).
4. Limpieza tipográfica (3 escalas) y reducción de micro-labels.

---
*Auditoría generada con gemini-frontend-design (DemoLab) + estado actual del código.*