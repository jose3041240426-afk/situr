/**
 * SITUR — Da de alta cuentas de operador.
 *
 * Crea las cuentas en Supabase Auth (que es donde vive la credencial) y su
 * ficha en `usuarios` (que es donde vive el rango y el módulo). Las dos cosas
 * tienen que existir: sin fila en `usuarios` la cuenta no puede entrar, y
 * sin cuenta en Auth la fila no puede iniciar sesión.
 *
 * POR QUÉ EL MFA NACE DESACTIVADO
 *
 * El segundo factor se inscribe con la aplicación autenticadora del propio
 * operador: necesita su teléfono y su tiempo. Un alta en bloque no puede
 * dejar a cinco personas con un factor que no se han configurado, porque el
 * sistema no tiene ni el teléfono ni el código de nadie.
 *
 * La cuenta nace con `mfa_habilitado = false` y sin factores inscritos. Al
 * entrar por primera vez, el sistema detecta que no hay factor verificado y
 * lleva al operador a la pantalla de inscripción (RF-026). También se puede
 * activar desde la ficha de perfil.
 *
 * Uso:
 *   node scripts/crear-cuentas.mjs            # el grupo de cuentas
 *   node scripts/crear-cuentas.mjs --listar    # solo muestra lo que hay
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const secretos = {}
for (const linea of readFileSync(
  fileURLToPath(new URL('../secretos.env', import.meta.url)),
  'utf8',
).split('\n')) {
  const m = linea.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) secretos[m[1]] = m[2].trim()
}

const URL_ = secretos.SUPABASE_URL
const SR = secretos.SUPABASE_SERVICE_ROLE_KEY
const psql = fileURLToPath(new URL('./psql-supabase.sh', import.meta.url))

/**
 * Las cuentas del grupo.
 *
 * `clave` es la contraseña. El patrón es el mismo en las cinco: dos palabras
 * del dominio y un número. Escribirlas y decirlas por teléfono no cuesta,
 * que es justo lo que hace falta cuando una persona nueva pide su clave.
 *
 * `numero_empleado` sigue el que ya usan las cuentas del municipio (EMP-0001,
 * EMP-0002…), para que la lista de personal se lea en orden.
 */
const CUENTAS = [
  {
    correo: 'maria.mathey@catastro.durango.gob.mx',
    clave: 'Durango.Catastro.01',
    nombres: 'María Fernanda',
    apellido: 'MATHEY',
    segundoApellido: 'TAVIZON',
    rol: 'ADMINISTRADOR',
    modulo: null,
    numero_empleado: 'EMP-0003',
  },
  {
    correo: 'luis.hernandez@catastro.durango.gob.mx',
    clave: 'Durango.Catastro.02',
    nombres: 'Luis Alberto',
    apellido: 'HERNANDEZ',
    segundoApellido: 'GUERRERO',
    rol: 'ADMINISTRADOR',
    modulo: null,
    numero_empleado: 'EMP-0004',
  },
  {
    correo: 'ana.simental@catastro.durango.gob.mx',
    clave: 'Durango.Catastro.03',
    nombres: 'Ana Sofía',
    apellido: 'SIMENTAL',
    segundoApellido: 'MATHEY',
    rol: 'ADMINISTRADOR',
    modulo: null,
    numero_empleado: 'EMP-0005',
  },
  {
    correo: 'rodrigo.tavizon@catastro.durango.gob.mx',
    clave: 'Durango.Ventana.01',
    nombres: 'Rodrigo',
    apellido: 'TAVIZON',
    segundoApellido: 'HERNANDEZ',
    rol: 'AGENTE',
    modulo: 'M01',
    numero_empleado: 'EMP-0006',
  },
  {
    correo: 'diana.guerrero@catastro.durango.gob.mx',
    clave: 'Durango.Ventana.02',
    nombres: 'Diana',
    apellido: 'GUERRERO',
    segundoApellido: 'SIMENTAL',
    rol: 'AGENTE',
    modulo: 'M02',
    numero_empleado: 'EMP-0007',
  },
]

async function auth(ruta, cuerpo) {
  const r = await fetch(`${URL_}/auth/v1${ruta}`, {
    method: 'POST',
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  })
  const t = await r.text()
  let j = null
  try {
    j = JSON.parse(t)
  } catch {
    /* no era JSON */
  }
  return { status: r.status, j, t }
}

if (process.argv.includes('--listar')) {
  execFileSync('bash', [psql, '-tA', '-c', 'SELECT email || \' | \' || numero_empleado || \' | activo=\' || activo || \' | mfa=\' || mfa_habilitado FROM public.usuarios ORDER BY numero_empleado'], {
    stdio: 'inherit',
  })
  process.exit(0)
}

for (const c of CUENTAS) {
  // 1) La cuenta en Supabase Auth
  const creado = await auth('/admin/users', {
    email: c.correo,
    password: c.clave,
    email_confirm: true,
  })

  let uid = creado.j?.id
  if (!uid) {
    // Ya existía: se busca por correo para no crear un duplicado.
    const r = await fetch(
      `${URL_}/auth/v1/admin/users?page=1&per_page=200`,
      { headers: { apikey: SR, Authorization: `Bearer ${SR}` } },
    )
    const lista = await r.json()
    const encontrado = lista?.users?.find((u) => u.email === c.correo)
    uid = encontrado?.id
    console.log(`· ${c.correo}: ya existía`)
  } else {
    console.log(`· ${c.correo}: creada`)
  }

  if (!uid) {
    console.error(`  ✗ no se pudo resolver el identificador`)
    continue
  }

  // 2) La ficha en `usuarios`, con el MFA desactivado
  const sql = `
  INSERT INTO public.usuarios
    (auth_uid, nombres, apellido_paterno_id, apellido_materno_id, email,
     numero_empleado, rol_id, modulo_id, activo, mfa_habilitado)
  VALUES (
    '${uid}',
    '${c.nombres}',
    (SELECT id FROM public.apellidos WHERE apellido = '${c.apellido}'),
    (SELECT id FROM public.apellidos WHERE apellido = '${c.segundoApellido}'),
    '${c.correo}',
    '${c.numero_empleado}',
    (SELECT id FROM public.roles WHERE clave = '${c.rol}'),
    ${c.modulo ? `(SELECT id FROM public.modulos WHERE codigo = '${c.modulo}')` : 'NULL'},
    true,
    false
  )
  ON CONFLICT (email) DO UPDATE
    SET auth_uid = EXCLUDED.auth_uid,
        rol_id = EXCLUDED.rol_id,
        modulo_id = EXCLUDED.modulo_id,
        activo = true,
        mfa_habilitado = false;
  `
  try {
    execFileSync('bash', [psql, '-tA', '-c', sql], { stdio: 'pipe' })
    console.log(`  ✓ ficha en \`usuarios\` · ${c.rol}${c.modulo ? ` · ${c.modulo}` : ''} · MFA desactivado`)
  } catch (e) {
    console.error('  ✗ no se pudo crear la ficha')
  }
}

console.log('\n════════ CUENTAS CREADAS ════════')
for (const c of CUENTAS) {
  console.log(`${c.correo}\n    ${c.clave}   (${c.rol}${c.modulo ? ` · ${c.modulo}` : ''})`)
}
console.log('\nEl segundo factor se configura en el primer acceso de cada persona.')
