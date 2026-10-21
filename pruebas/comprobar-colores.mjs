#!/usr/bin/env node
/**
 * SITUR — Comprueba que todas las clases de color existen.
 *
 * Por qué hace falta: en Tailwind, una clase mal escrita **no da error**.
 * `text-azul-500` en vez de `text-azul-50` compila sin quejarse y simply
 * no aplica estilo: el texto se queda en el color por defecto y nadie se
 * entera hasta que lo mira. Ni el typecheck lo detecta (no son tipos), ni
 * el escaneo de accesibilidad (una falta de contraste sí se vería, pero un
 * color que se ha hecho desaparecer no).
 *
 * Qué hace: extrae del código todas las clases de color que se usan, las
 * busca en el CSS compilado y falla si alguna no está.
 *
 * Uso:  node pruebas/comprobar-colores.mjs
 * Salida: 0 si todo cuadra, 1 si hay clases que no existen.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const raiz = path.resolve(aqui, '..')

/* --- 1) Todas las clases de color que usa el código --- */
const FAMILIAS = [
  'gris',
  'azul',
  'navy',
  'verde',
  'ambar',
  'rojo',
  'morado',
]
const PREFIJOS = [
  'bg',
  'text',
  'border',
  'ring',
  'from',
  'to',
  'via',
  'divide',
  'outline',
  'fill',
  'stroke',
  'shadow',
  'accent',
  'caret',
  'placeholder',
  'decoration',
]
// Con el prefijo de variante opcional: `hover:text-azul-500`, `sm:bg-gris-50`…
const patron = new RegExp(
  `(?<![\\w-])((?:[a-z-]+:)*(?:${PREFIJOS.join('|')})-(?:${FAMILIAS.join('|')})-\\d{2,3})(?![\\w-])`,
  'g',
)

function ficheros(dir, acc = []) {
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada)
    if (statSync(completo).isDirectory()) ficheros(completo, acc)
    else if (/\.(tsx|ts)$/.test(completo)) acc.push(completo)
  }
  return acc
}

const usadas = new Map()
for (const f of ficheros(path.join(raiz, 'src'))) {
  const texto = readFileSync(f, 'utf8')
  for (const m of texto.matchAll(patron)) {
    const clase = m[1]
    if (!usadas.has(clase)) usadas.set(clase, [])
    usadas.get(clase).push(path.relative(raiz, f))
  }
}

/* --- 2) Las que existen en el CSS compilado --- */
const css = path.join(raiz, 'dist', 'assets')
let cssCompilado = ''
if (existsSync(css)) {
  for (const f of readdirSync(css)) {
    if (f.endsWith('.css')) cssCompilado += readFileSync(path.join(css, f), 'utf8')
  }
}

if (!cssCompilado) {
  console.error(
    'No hay CSS compilado en dist/assets. Ejecuta primero:  npm run build',
  )
  process.exit(2)
}

/* --- 3) El veredicto --- */
const faltan = []
for (const [clase, ficheros] of usadas) {
  // En el CSS, Tailwind escapa los caracteres especiales del nombre de la
  // clase: `hover:text-azul-500` se compila como `.hover\:text-azul-500`.
  const selector = '.' + clase.replace(/([:/[\]%.])/g, '\\$1')
  if (!cssCompilado.includes(selector)) {
    faltan.push({ clase, ficheros: [...new Set(ficheros)] })
  }
}

console.log(
  `SITUR — clases de color: ${usadas.size} usadas, ${cssCompilado.length} bytes de CSS`,
)
if (faltan.length === 0) {
  console.log('  OK   todas existen en el CSS compilado')
  process.exit(0)
}
console.log(`  FALLAN ${faltan.length}:`)
for (const f of faltan) {
  console.log(`    ${f.clase}  (${f.ficheros.join(', ')})`)
}
process.exit(1)
