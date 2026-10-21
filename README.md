# SITUR — Sistema Web de Gestión y Seguimiento de Turnos

**Dirección de Catastro · Durango**

Aplicación del **DRS v1.9** (documento de requisitos). React 19 + TypeScript
sobre Vercel, con Supabase (PostgreSQL) como autoridad de los turnos.

> **Qué es este repositorio**: **la aplicación**. El DRS, las migraciones en
> SQL plano, la suite de 138 aserciones y el tutorial con capturas viven en
> el proyecto completo, en las carpetas hermanas `migracion/`, `tutorial/` y
> en la raíz. Lo que sí está aquí es todo lo que hace falta para
> **desplegar**: el código, las migraciones en el formato de la CLI de
> Supabase (`supabase/migrations/`), la semilla y los scripts de instalación.

---

## 1. Qué hace

| Superficie | Ruta | Quién entra | Para qué |
|---|---|---|---|
| Consola del operador | `/admin/*` | Personal autorizado (Supabase Auth + MFA) | Emitir, llamar, atender, omitir, cancelar y cerrar la jornada |
| Portal del ciudadano | `/turno/{token}` | Anónimo | Consultar su turno con el código QR. Sin cuenta, sin datos personales |
| Pantalla pública | `/pantalla` | Anónimo | Últimas llamadas (folio → módulo). **Opcional**: si no hay televisor, no se enciende y nada más cambia (DRS §5.1) |

**El recorrido de un turno, de principio a fin:**

```
Ciudadano llega a la ventanilla
   └─ el operador emite un turno  →  la base le numera el folio (A-001, L-001…)
        └─ se imprime el boleto con un QR  →  el ciudadano lo escanea con el teléfono
             └─ su portal ya muestra su turno, su posición y su estado
                  └─ el operador llama  →  el teléfono se repinta solo
                       └─ atiende y finaliza  →  todo queda en la auditoría
```

---

## 2. La regla que gobierna todo

**PostgreSQL es la autoridad.** Los estados, la concurrencia, el folio
consecutivo y la auditoría se resuelven en la base, nunca en el navegador.

- El cliente **escribe solo a través de RPC**. No hay un solo `insert`/`update`
  del frontend sobre una tabla de negocio.
- El ciudadano **nunca** hace `SELECT` sobre `turnos`: su rol `anon` no tiene
  privilegio sobre esa tabla. Consulta `get_turno_publico(token)`.
- La máquina de estados (6 estados, 6 transiciones) vive en
  `fn_transicion_valida()`. El frontend no puede inventarse un estado.

Los seis estados de un turno: `WAITING` → `CALLED` → `SERVING` →
`COMPLETED`, y desde cualquier punto `CANCELLED` u `SKIPPED`.

---

## 3. Instalación

Hay dos caminos, y los dos terminan con **el sistema operando**:

- **[3.1](#31--contra-supabase-la-instalación-real)** — Supabase + Vercel. Es
  la instalación de verdad, la que se despliega.
- **[3.2](#32--en-local-sin-internet)** — un PostgreSQL local y el arnés de
  `pruebas/`. Para trabajar sin conexión y sin gastar nada.

Lo que **no** hace falta en ninguno de los dos: una base de datos que
preparar a mano, un usuario que crear, un catálogo que inventarse. Las
migraciones crean el esquema y la semilla lo puebla.

### Qué hace falta

| | Para el camino A (Supabase) | Para el camino B (local) |
|---|---|---|
| Node.js **20.19+** o **22.12+** (lo que pide Vite 7) | sí | sí |
| npm | sí | sí |
| Una cuenta de Supabase | sí | no |
| Una cuenta de Vercel | solo al desplegar | no |
| PostgreSQL 15 o superior | no (lo da Supabase) | sí, en local |

---

### 3.1 Contra Supabase (la instalación real)

#### Paso 1 · Clonar y instalar

```bash
git clone https://github.com/jose3041240426-afk/situr.git
cd situr
npm install
```

#### Paso 2 · Crear el proyecto en Supabase

En <https://supabase.com/dashboard> → **New project**. Ponle nombre y una
contraseña de base de datos (esa no se usa más adelante: la base ya trae la
suya).

Cuando termine, abre **Project Settings → API** y anota tres cosas:

| Qué | Dónde está | Para qué |
|---|---|---|
| **Project URL** | Project Settings → API | `SUPABASE_URL` |
| **anon public key** | Project Settings → API → API Keys | `SUPABASE_ANON_KEY` |
| **service_role key** | Project Settings → API → API Keys (sección *Secret keys*) | `SUPABASE_SERVICE_ROLE_KEY` |

> La `service_role` **se salta la RLS**: es la llave maestra de la base. Va
> solo en el servidor, nunca en el navegador.

#### Paso 3 · Enlazar la CLI con el proyecto

```bash
npm install -g supabase
supabase login
supabase link --project-ref <el-ref-del-proyecto>
```

El *ref* está en la URL del panel: `supabase.com/dashboard/project/<ref>`.

#### Paso 4 · Crear los secretos

```bash
node scripts/generar-secretos.mjs
```

Crea **`secretos.env`** (permisos 600) con el par de claves VAPID, el
`CRON_SECRET` y una contraseña de administrador aleatoria. Ábrelo y rellena
los tres campos que quedan:

```bash
$EDITOR secretos.env
```

```
SUPABASE_URL=https://<tu-ref>.supabase.co
SUPABASE_ANON_KEY=<la anon public key>
SUPABASE_SERVICE_ROLE_KEY=<la service_role key>
UPSTASH_REDIS_REST_URL=<de upstash.com, o vacío>
UPSTASH_REDIS_REST_TOKEN=<de upstash.com, o vacío>
```

**Upstash es opcional**: sin él, el límite de tasa del §10 no se aplica y el
sistema funciona igual. Con él, se aplica.

#### Paso 5 · Aplicar el esquema y los datos

```bash
supabase db push
```

Aplica las migraciones de `supabase/migrations/` en orden: 12 tablas, 6
vistas, las RPC, la RLS y los permisos. Es idempotente.

Ahora los **datos** (roles, trámites, módulos, configuración y el
administrador). La CLI no los aplica, así que van por `psql`:

```bash
# La cadena de conexión está en Project Settings → Database → Connection string
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

> Si `psql` no está instalado: `apt install postgresql-client`. La cadena
> lleva la contraseña de la base; puedes ponerla en la variable `PGPASSWORD`.

#### Paso 6 · Crear el administrador y enlazarlo

```bash
node scripts/arrancar.mjs
```

Esto es lo que SQL **no puede** hacer: la sesión vive en Supabase Auth, fuera
de la base. El script crea el usuario en Auth, le pone la contraseña de
`secretos.env` y rellena `usuarios.auth_uid`. **Sin este enlace el registro
existe pero no hay quien lo deje pasar.**

#### Paso 7 · Comprobar que funciona

```bash
node scripts/enlace-local.mjs     # escribe .env.local con SOLO lo público
npm run dev
```

Abre <http://localhost:5173/admin> y entra con el correo y la contraseña de
`secretos.env`.

**En el primer acceso hay que cambiar la contraseña e inscribir el segundo
factor**: la consola ofrece «Configurar ahora», se escanea el QR con la
aplicación de autenticación (Authy, Google Authenticator, 2FAS…) y se teclea
el código de seis dígitos. A partir de ahí, cada acceso pide correo,
contraseña **y** código.

#### Paso 8 · Desplegar en Vercel

```bash
npm install -g vercel
vercel link                      # o: vercel --yes
scripts/desplegar.sh --proyecto=<ref>
```

El script migra la base, pasa las variables de entorno a Vercel (las
sensibles con `--sensitive`) y despliega. Pasa **once** variables:

| A Vercel | Sensible | De dónde sale |
|---|---|---|
| `VITE_SUPABASE_URL` | no | `SUPABASE_URL` de `secretos.env` |
| `VITE_SUPABASE_ANON_KEY` | no | `SUPABASE_ANON_KEY` de `secretos.env` |
| `VITE_VAPID_PUBLIC_KEY` | no | `VAPID_PUBLIC_KEY` de `secretos.env` |
| `SUPABASE_URL` | sí | `secretos.env` |
| `SUPABASE_ANON_KEY` | sí | `secretos.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | `secretos.env` |
| `VAPID_PRIVATE_KEY` | sí | `secretos.env` |
| `CRON_SECRET` | sí | `secretos.env` |
| `UPSTASH_REDIS_REST_URL` | sí | `secretos.env` (puede ir vacío) |
| `UPSTASH_REDIS_REST_TOKEN` | sí | `secretos.env` (puede ir vacío) |

Las que empiezan por `VITE_` van al **navegador**; las demás, solo al
servidor. El script **falla** si `secretos.env` tiene marcadores sin
rellenar.

#### (Opcional) Realtime

Sin Realtime el sistema funciona: el panel refresca cada 15 s y el portal del
ciudadano sondea cada 10 s. Realtime lo hace inmediato. En el **panel de
Supabase → Database → Extensions**, habilita `pg_cron` y luego aplica:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261019130000_07_pg_cron.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261019130001_08_supabase_realtime.sql
```

---

### 3.2 En local (sin internet)

El arnés de `pruebas/` levanta un Supabase mínimo sobre un PostgreSQL local:
PostgREST para los datos y un GoTrue propio para el login. Así la aplicación
se prueba **con la base real y la RLS real**, sin conexión.

#### Paso 1 · Clonar e instalar

```bash
git clone https://github.com/jose3041240426-afk/situr.git
cd situr
npm install
```

#### Paso 2 · Tener un PostgreSQL local

Cualquier PostgreSQL 15 o superior sirve. Comprobarlo:

```bash
psql -X -c "SELECT version();" -d postgres
```

Si `psql` no conecta, es que el servidor no está en marcha. En Debian/Ubuntu:

```bash
sudo systemctl start postgresql
```

#### Paso 3 · PostgREST (una sola vez)

PostgREST es el binario que traduce HTTP a SQL. No viene con PostgreSQL:

```bash
mkdir -p /tmp/opencode
curl -sSL -o /tmp/opencode/pgrst.tar.xz \
  https://github.com/PostgREST/postgrest/releases/download/v16.4/postgrest-v16.4-linux-static-x86_64.tar.xz
tar -xJf /tmp/opencode/pgrst.tar.xz -C /tmp/opencode
```

#### Paso 4 · Levantar el stack

```bash
pruebas/levantar.sh situr_app
```

El script hace todo, en este orden:

1. **Crea la base `situr_app`** y aplica las migraciones de
   `supabase/migrations/` con `pruebas/00_stubs.sql` delante. Los stubs crean
   los roles `anon` y `authenticated` y el esquema `auth` con `auth.uid()`,
   que en Supabase ya existen pero en un PostgreSQL local no.
2. **Levanta PostgREST** en el puerto 3000.
3. **Levanta el arnés de autenticación** en el 9999 y el proxy en el 54321.
4. **Escribe `.env.local`** con la URL y la clave anon del arnés.

> Si el proyecto completo está a mano (carpeta hermana `migracion/`), el
> script usa esa carpeta en vez de las migraciones de este repositorio, y
> aplica además la suite de pruebas.

Cuando dice «Ya puedes arrancar la aplicación», deja esa terminal abierta.

#### Paso 5 · Arrancar la aplicación

En **otra** terminal:

```bash
npm run dev
```

Abre <http://localhost:5173/admin>.

#### Las cuentas de prueba

| Correo | Contraseña | Usuario en la base | Rol | MFA |
|---|---|---|---|---|
| `admin@situr.local` | `situr-admin-2026` | `EMP-0001` (GUERRERO SIMENTAL) | Administrador | `123456` |
| `agente@situr.local` | `situr-agente-2026` | `EMP-0002` | Administrador † | `123456` |

† **Ojo con el nombre**: la cuenta se llama «agente», pero su rol acaba
siendo **Administrador**. El rol `AGENTE` está en el DRS y en
`fn_puede_operar_turnos()`, pero **no se siembra** (el §3 del DRS dice que en
el MVP solo se siembran `ADMINISTRADOR` y `SUPERVISOR`), así que el arnés cae
al rol de administrador. Para tener un operador de verdad con permisos
reducidos, hay que sembrar el rol `AGENTE` y asignárselo.

El código MFA del arnés es siempre `123456`. En Supabase de verdad el segundo
factor es el de tu aplicación de autenticación.

> Estas credenciales **solo valen contra el arnés local**, que es un servidor
> de autenticación propio y no toca Supabase.

#### Si algo falla

| Síntoma | Causa |
|---|---|
| «Falta la configuración de Supabase» | No hay `.env.local`. Se escribe con `pruebas/levantar.sh` o con `node scripts/enlace-local.mjs`. |
| `supabaseUrl is required` | Lo mismo: `.env.local` no existe o no tiene `VITE_SUPABASE_URL`. |
| `PGRST202` (PostgREST no encuentra una función) | La caché de esquema de PostgREST está desfasada: `NOTIFY pgrst, 'reload schema';` en la base. `levantar.sh` ya lo hace. |
| `FATAL: no existe el rol "postgres"` | El `PGUSER` no es el del sistema. `export PGUSER=postgres`. |
| «La migración falló» | Revisa `psql -X -d situr_app -c "\d+ turnos"`: si la tabla existe, es que la base no estaba vacía. |

---

### 3.3 Variables de entorno

| Variable | Dónde vive | Para qué |
|---|---|---|
| `VITE_SUPABASE_URL` | navegador | URL del proyecto Supabase |
| `VITE_SUPABASE_ANON_KEY` | navegador | Clave **anon**: la RLS es la que manda |
| `VITE_VAPID_PUBLIC_KEY` | navegador | Clave pública VAPID (Web Push) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | servidor | Las mismas, para `api/suscripcion` |
| `SUPABASE_SERVICE_ROLE_KEY` | **solo servidor** | La cola de avisos de push |
| `VAPID_PRIVATE_KEY` | **solo servidor** | Firma de los avisos |
| `CRON_SECRET` | **solo servidor** | Autoriza al cron a llamar a `/api/push` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | servidor | Límite de tasa del Edge Middleware |

> La `service_role` **jamás** debe llegar al navegador: se salta la RLS.
> `scripts/enlace-local.mjs` se encarga de que no llegue, y falla en vez de
> escribir una configuración con marcadores sin rellenar.

Las claves VAPID se generan una vez con `scripts/generar-secretos.mjs`.

### 3.4 Los scripts

| Script | Qué hace |
|---|---|
| `scripts/generar-secretos.mjs` | Crea `secretos.env` con VAPID, `CRON_SECRET` y la contraseña del administrador (permisos 600) |
| `scripts/enlace-local.mjs` | Pasa a `.env.local` **solo** las variables públicas |
| `scripts/arrancar.mjs` | Crea el administrador en Supabase Auth y lo enlaza con `usuarios.auth_uid`; comprueba que el sistema responde |
| `scripts/desplegar.sh` | Migra la base, pasa las variables a Vercel y despliega |

---

## 4. La base de datos y los datos

### 4.1 Qué se aplica

El DDL está en **`supabase/migrations/`**, con el formato que la CLI de
Supabase espera, y `supabase/seed.sql` con los catálogos y el usuario
administrador. Es lo que se aplica en producción:

```bash
supabase link --project-ref <ref>
supabase db push          # aplica supabase/migrations/ en orden
```

En el proyecto completo hay además una carpeta `migracion/` con las mismas
migraciones en SQL plano, la **suite de 138 aserciones** y el volcado
restaurable. No está en este repositorio porque aquí está únicamente la
aplicación.

En Supabase no hace falta el `00_stubs.sql` del proyecto completo: el
esquema `auth`, `auth.uid()` y los roles `anon`/`authenticated`/`service_role`
ya existen, y crearlos sería duplicarlos.

### 4.2 Los datos que trae el sistema

La semilla (`supabase/seed.sql`) deja el sistema **operativo** de una vez:
no hay que inventarse ni un solo dato para empezar a trabajar.

**Roles** (`roles`)

| Clave | Nombre | Para qué |
|---|---|---|
| `ADMINISTRADOR` | Administrador | Opera turnos, gestiona usuarios, catálogos y módulos |
| `SUPERVISOR` | Supervisor | **No** opera turnos: ve y supervisa. Es la separación de poderes del RF-004 |

**Trámites** (`tramites`) — el prefijo es la primera letra del código de turno

| Clave | Prefijo | Denominación | Tiempo estimado | Prioridad por defecto |
|---|---|---|---|---|
| `PRED` | `A` | Predial | 10 min | Normal |
| `LIC` | `L` | Licencias y permisos | 20 min | Normal |
| `CONST` | `C` | Constancias | 5 min | Normal |
| `GRAV` | `G` | Gravámenes y gravamen | 15 min | Normal |
| `REG` | `R` | Registro catastral | 25 min | **Preferente** |

**Módulos** (`modulos`)

| Código | Denominación | Estado |
|---|---|---|
| `M01` | Módulo 01 - Atención general | Activo |
| `M02` | Módulo 02 - Documentación | Activo |
| `M03` | Módulo 03 - Información | Activo |
| `M04` | Módulo 04 - Reserva | **Pausado** (no entra en el reparto de llamadas) |

**Configuración** (`configuracion`) — los ocho parámetros que gobiernan el
comportamiento, todos con su valor por defecto

| Clave | Qué gobierna | Valor |
|---|---|---|
| `POSICION_AVISO_PUSH` | Posición en la cola a partir de la cual se avisa por push | 3 |
| `MINUTOS_AVISO_PUSH` | Minutos de espera a partir de los cuales se avisa | 10 |
| `MINUTOS_TIMEOUT_LLAMADA` | Tiempo que un turno llamado espera antes de quedar libre | 5 |
| `MAXIMO_TURNOS_DIARIOS` | Tope de turnos por trámite y día | 999 |
| `LONGITUD_NUMERO_FOLIO` | Longitud del número de turno | 3 |
| `MINUTOS_VIGENCIA_TOKEN_EN_ESPERA` | Cuánto vive el token del QR con el turno en espera | 1440 (24 h) |
| `HORAS_VIGENCIA_TOKEN_ATENDIDO` | Cuánto vive el token con el turno ya atendido | 24 |
| `HORAS_VIGENCIA_TOKEN_CERRADO` | Cuánto vive el token con el turno cancelado u omitido | 1 |

### 4.3 Las cuentas que ya existen

**En el arnés local** (desarrollo): la tabla está en
[§3.2, «Las cuentas de prueba»](#las-cuentas-de-prueba).

**En una instalación real** (Supabase), la cuenta se crea con
`scripts/generar-secretos.mjs` + `scripts/arrancar.mjs`:

| Correo | Contraseña |
|---|---|
| `admin@catastro.durango.gob.mx` | **Aleatoria**, de 18 bytes en base64url. Se genera en `secretos.env` y hay que cambiarla en el primer acceso, junto con la inscripción del segundo factor (RF-026) |

Esa contraseña **nunca** se escribe en el repositorio: vive en
`secretos.env`, que tiene permisos 600 y está en el `.gitignore`.

### 4.4 Cómo importar los datos

El camino normal está en [§3.1, paso 5](#paso-5--aplicar-el-esquema-y-los-datos):
`supabase db push` para el esquema y `psql -f supabase/seed.sql` para los
datos. La semilla es **idempotente** (todo lleva `ON CONFLICT DO NOTHING`): se
puede volver a aplicar sin miedo.

En local, los dos pasos los hace `pruebas/levantar.sh` de una vez.

Y si lo que se quiere es **traer los turnos y la auditoría** de otra
instalación, el volcado es el camino (`pg_dump` de la fuente y `psql` sobre
el destino):

```bash
# Volcado del proyecto completo (BD_SITUR_v1.5.txt)
createdb situr
psql -X -v ON_ERROR_STOP=1 -d situr -f ../BD_SITUR_v1.5.txt
```

El volcado es de un PostgreSQL estándar: **no** es un sustituto de Supabase
(le faltan Auth, Realtime y el panel), pero sirve para levantar la base y
correr la suite.

Antes de restaurar encima de una base con datos, **vólcala**: las tablas
`turnos`, `folios` y `auditoria` tienen dependencias entre sí y el volcado no
es idempotente.

### 4.5 Verificar la instalación

La suite está en la carpeta hermana `migracion/` del proyecto completo (aquí
solo está la aplicación):

```bash
cd ../migracion
psql -X -v ON_ERROR_STOP=1 -d situr -f prueba/01_pruebas.sql
# debe imprimir: TODAS LAS PRUEBAS PASARON   (138 aserciones)
```

---

## 5. Guía de uso, paso a paso

### 5.1 El operador: del acceso al cierre de la jornada

**1 · Entrar.** `http://<tu-dominio>/admin`. Correo institucional y
contraseña. En el primer acceso hay que **inscribir el segundo factor**:
«Configurar ahora», se escanea el QR con la aplicación de autenticación y
se teclea el código de seis dígitos. A partir de ahí, cada acceso pide
correo, contraseña **y** código: una contraseña robada no basta para emitir
turnos.

**2 · Abrir el periodo.** Sin un periodo abierto la base **rechaza** cualquier
alta de turno. «Abrir periodo de hoy». El periodo es el día de trabajo: al
cerrarlo, los turnos que queden en espera pasan a *omitidos*.

**3 · Emitir un turno.** Se elige el **trámite** y la **prioridad**, y se
pulsa «Emitir turno». La base numera el folio de forma **atómica**: dos
ventanillas simultáneas no reparten el mismo número (el contador vive en la
tabla `folios` con `ON CONFLICT … DO UPDATE`, no en un `count`).

Aparece la tarjeta del turno emitido con el **QR**. Se puede **imprimir**
(el botón imprime **solo** el boleto, no la consola) o enseñar la pantalla.

**4 · Entregar el QR.** El ciudadano lo escanea con el teléfono y su portal
ya muestra su turno. No hay que explicarle nada más: no hay que registrarse
en nada.

**5 · Llamar.** Antes de apretar, la consola dice **a quién va a llamar el
sistema y por qué** («EL SISTEMA VA A LLAMAR A», con la razón). El orden de
llamada es **global entre trámites** y determinista, no un «orden por
trámite» que jerarquice sin querer. «Llamar».

Si hay que atender a otro antes, en la fila de la cola está **«Llamar a
este»**: el turno ajeno **no se quema**, sigue en la cola.

**6 · Atender.** El turno llamado pasa a «En atención ahora», con su módulo.
«Atender» abre la atención.

**7 · Finalizar.** «Finalizar» cierra la atención. Cada transición queda en
el historial y en la auditoría, con el operador, la hora y el motivo. Esa
traza es **inmutable**: ni el propio administrador puede editarla.

**8 · Omitir o cancelar (cuando toca).** Si el ciudadano no aparece, se
**omite**: el turno sale de la cola y hay que **reponerlo** (paso 9). Si el
turno se emitió por error (trámite equivocado), se **cancela**. Las dos
piden un motivo, y quedan en la traza.

**9 · Reponer un turno omitido.** En «Historial» está la acción de reponer.
Sale un **turno nuevo** con su propio QR, que se le da al ciudadano. El
anterior queda como *omitido*, con su motivo a la vista.

**10 · Cerrar el periodo.** «Cerrar periodo» pide confirmación y dice
exactamente cuántos turnos se van a perder. Los que queden en espera pasan a
*omitidos*.

### 5.2 El ciudadano: desde el QR hasta oponerse

**1 · Escanear el QR.** El teléfono abre `http://<dominio>/turno/{token}`.
No hay cuenta, ni registro, ni correo, ni teléfono: **el token del QR es la
única credencial**, y solo mientras el turno siga vivo.

**2 · Ver su turno.** El código, el estado, la posición en la cola, las
personas que tiene delante, el tiempo estimado y el módulo. **Solo su
turno**: el rol `anon` no tiene privilegio sobre la tabla de turnos.

**3 · El aviso de privacidad** está a un clic, y dice lo que el sistema
cumple de verdad: qué se guarda, durante cuánto, quién es el tercero cuando
se aceptan los avisos y cómo se retira el permiso.

**4 · Pedir los avisos (opcional).** «Sí, avisarme» pide el permiso del
navegador **después** de haber visto el turno, nunca en frío. El aviso llega
aunque la pestaña esté cerrada y lleva folio, módulo y mensaje: **ni token,
ni nombres**. Con «Dejar de avisarme» se retira el consentimiento y se da de
baja la suscripción.

**5 · Oponerse al tratamiento (opcional).** «No quiero que se atienda mi
turno»: escribe su consideración y se pulsa **«Registrar mi consideración»**.
El turno queda **cancelado**, con constancia de que fue el titular y no la
ventanilla. El operador lo ve en la tarjeta «Retirados por el titular».

### 5.3 La pantalla de la sala de espera

`http://<dominio>/pantalla`, en un televisor o monitor. Muestra a quién se
está llamando: **código, módulo y trámite. Sin datos personales**, porque
no los hay. Es **opcional**: si no hay televisor, no se enciende y nada más
cambia (DRS §5.1).

### 5.4 Los endpoints

| Ruta | Método | Qué hace | Límite de tasa |
|---|---|---|---|
| `/api/turno?token=…` | `GET` | La consulta pública del turno | 30/min por IP + token |
| `/api/login` | `POST` | El acceso del operador | 10/10 min por IP + cuenta |
| `/api/suscripcion` | `POST` / `DELETE` | Alta y baja de la suscripción push | 10/min por IP + token |
| `/api/consideraciones` | `POST` | La oposición del titular | — |
| `/api/ultimas-llamadas` | `GET` | La pantalla pública | 120/min por prefijo de red |
| `/api/push` | `POST` | El emisor de avisos (lo llama el cron) | Solo con `CRON_SECRET` |

---

## 6. Realtime (opcional, pero recomendado)

La aplicación **no depende** de Realtime: el panel refresca cada 15 s y el
portal del ciudadano sondea cada 10 s. Realtime lo hace inmediato.

Cómo se habilita, paso a paso: [§3.1, «(Opcional) Realtime»](#opcional-realtime).

### 6.1 Publicar los cambios de `turnos` (para el panel)

En Supabase, la tabla debe estar en la publicación:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.turnos;
```

### 6.2 Difundir el cambio al ciudadano (para el portal)

El portal escucha un canal `turno:{token}` que **no transporta datos**: solo
avisa de que algo cambió, y la pantalla vuelve a preguntar. Para que la base
difunda, hace falta el disparador de Supabase:

```sql
-- En Supabase: realtime.send() existe en el esquema `realtime`.
CREATE OR REPLACE FUNCTION public.fn_difundir_cambio_turno()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM realtime.send(
        jsonb_build_object('turno_id', NEW.id, 'cambio', true),
        'turno-cambio',
        'turno:' || NEW.token_publico,
        TRUE
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_difundir_cambio_turno
    AFTER UPDATE OF estado ON public.turnos
    FOR EACH ROW EXECUTE FUNCTION public.fn_difundir_cambio_turno();
```

**Nota de seguridad:** el canal lleva el token en su nombre. Eso no filtra
nada —el mensaje no lleva datos y quien no conozca el token no puede
preguntar por el turno—, pero si se quiere el máximo, el canal puede ser
privado (`private = TRUE` en `realtime.send`) y autorizarlo con políticas sobre
`realtime.messages`.

---

## 7. Las notificaciones push (RF-028)

```
Ciudadano escanea el QR
      │
      ▼
  /turno/{token}  ──►  get_turno_publico(token)  ──►  ve su turno
        │                                              (AQUÍ, y no antes)
        ▼
  "¿Queremos avisarle…?"  ──►  Service Worker  ──►  pushManager.subscribe()
        │                                                        │
        │                                                        ▼
        │                                    POST /api/suscripcion  (middleware: IP+token)
        │                                                        │
        │                                                        ▼
        │                                        suscripciones_push  (UNIQUE token_publico)
        │                                                        │
        │   (cada minuto)  Vercel Cron ──► POST /api/push         │
        │                                  │                       │
        │                                  ▼                       ▼
        │                    suscripciones_por_notificar()   Web Push (VAPID)
        │                    (solo service_role)                   │
        │                                  │                       ▼
        │                                  ▼                NAVEGADOR
        │                      marcar_aviso_push_enviado()   "Su turno A-041
        │                      (para no repetir)               está próximo"
        ▼
    Al cerrarse el turno, un disparador retira la suscripción
```

**El permiso se pide después de mostrar el turno**, nunca al entrar. Pedirlo
en frío suele ser rechazado y hunde la tasa de aceptación.

El aviso **no lleva el token**: lleva folio, módulo y mensaje, y nada más. El
destino lo resuelve el Service Worker del propio ciudadano, que guarda el
token en su disco. Mandarlo en el aviso lo mandaría al proveedor de push,
que es un tercero.

### El cron

```json
{ "crons": [{ "path": "/api/push", "schedule": "* * * * *" }] }
```

**Configurar `CRON_SECRET`**: sin él, `/api/push` se rechaza en producción, y es
lo correcto, porque mejor no enviar avisos que dejarlos abiertos a internet
(DRS §10).

---

## 8. Despliegue en Vercel

```bash
scripts/desplegar.sh --proyecto=<ref>
```

El script migra la base, pasa las variables de entorno a Vercel (las
sensibles con `--sensitive`) y despliega.

---

## 9. Estructura

```
app/
├── api/
│   ├── consideraciones.ts   La oposición del titular (RF-033, LFPDPPP art. 21)
│   ├── login.ts             El acceso del operador
│   ├── push.ts              El emisor de Web Push (solo el cron)
│   ├── suscripcion.ts       Alta/baja de suscripciones push
│   ├── turno.ts             La consulta pública del turno
│   └── ultimas-llamadas.ts  La pantalla pública (RF-020)
├── middleware.ts             Límite de tasa (IP + token / IP + cuenta)
├── public/
│   ├── sw.js                 Service Worker: guarda el token y muestra el aviso
│   └── manifest.webmanifest
├── src/
│   ├── admin/                Consola: Entrar, Consola, Usuarios, Catálogos, Historial, Estadísticas
│   ├── ciudadano/            Portal del ciudadano y pantalla pública
│   ├── components/           Piezas visuales (Chip, Modal, QR…)
│   └── lib/
│       ├── tipos.ts          Tipos que reflejan 1:1 el DDL
│       ├── supabase.ts       Cliente de Supabase
│       ├── rpc.ts            Todas las llamadas a la base, tipadas
│       ├── auth.tsx          Sesión, rol y MFA
│       └── push.ts           Suscripción de Web Push
├── pruebas/                  Arnés local (PostgREST + GoTrue), escaneo y tutorial
├── scripts/                  Instalación: secretos, enlace, arranque, despliegue
├── supabase/
│   ├── migrations/           El DDL, en el formato de la CLI
│   ├── seed.sql              Los catálogos, la configuración y el administrador
│   └── config.toml
└── vite/                     Plugin que monta `api/` en el servidor de desarrollo
```

---

## 10. Pruebas

```bash
npm run typecheck             # TypeScript en modo estricto
npm run alto-impacto          # accesibilidad y comportamiento, 8 pantallas
npm run colores               # toda clase de color usada existe en el CSS
```

`npm run colores` comprueba que **toda** clase de color que aparece en el
código existe en el CSS compilado. En Tailwind una clase mal escrita **no
da error**: se queda sin estilo y nadie se entera hasta que lo mira. Con
316 clases en el sistema visual, eso no es un riesgo teórico.

`pruebas/alto-impacto.mjs` recorre la aplicación con un navegador real:
comprueba el árbol de accesibilidad con axe-core, el recorrido con teclado,
el desbordamiento horizontal a 320/768/1024/1440 px, el contraste calculado
tras la cascada completa, y que la pantalla pública **muestre** las llamadas
y que el aviso push **lleve al turno** del ciudadano.

El tutorial con capturas se regenera con:

```bash
pruebas/tutorial.sh           # base limpia + recorrido + TUTORIAL.pdf
```

### Arnés local (opcional)

`pruebas/` levanta un Supabase mínimo sobre un PostgreSQL local —PostgREST
para los datos y un GoTrue mínimo para el login— para poder probar la
aplicación **con la base real y la RLS real**, sin conexión a internet:

```bash
pruebas/levantar.sh situr_app   # migra la base, levanta PostgREST, auth y proxy
```

---

## 11. Qué queda fuera de la máquina

- **Los secretos**: la clave privada de VAPID, el `CRON_SECRET`, la
  `service_role` de Supabase y el token de Upstash. Se generan con
  `scripts/generar-secretos.mjs` y viven en `secretos.env` (permisos 600,
  fuera del repositorio).
- **La suite de 138 aserciones y `verificar-todo.sh`**: están en la carpeta
  hermana `migracion/` del proyecto completo.
- **El DRS, el tutorial y el volcado**: igual, en el proyecto completo.
- **La instalación en Supabase**: sigue pendiente de decidir de quién es la
  cuenta (`CONSULTA-14_CUENTA.txt` en el proyecto completo). Nada del código
  está atado a esa decisión.

---

*Proyecto de estadía. La documentación y el código están en español.*
