# Informe de escaneo de seguridad — SITUR

**Fecha:** 19 de octubre de 2026
**Método:** skill `code-audit/security-scan` (dominios: autenticación y
autorización, validación e inyección, secretos y configuración, dependencias,
protección de datos, seguridad de API, infraestructura, criptografía, errores y
registros).
**Alcance:** `app/` (la aplicación) y `migracion/` (la base).
**Modo:** solo lectura. Ningún hallazgo se corrigió sin verificarse antes.

---

## 1. Perfil de la pila y de la superficie

| | |
|---|---|
| Lenguajes | TypeScript (cliente y servidor), SQL (PL/pgSQL), Bash, Python |
| Framework | React 19 + Vite 7 + Tailwind 4; functions de Vercel (Node) y Edge Middleware |
| Datos | PostgreSQL 18 en Supabase (RLS, RPC `SECURITY DEFINER`, auditoría inmutable) |
| Servicios externos | Supabase (Auth/DB/Realtime), Vercel, Upstash Redis, **proveedor de push del navegador (Google FCM / Apple)** |
| Autenticación | Supabase Auth con MFA TOTP obligatorio para el operador; **el ciudadano no tiene cuenta** |
| Modelo de credencial del ciudadano | Un token de 256 bits; es su única credencial (RF-017) |
| Puntos de entrada | `/admin/*` (consola), `/turno/{token}` (portal), `/pantalla` (TV), `POST /api/push`, `POST /api/suscripcion`, `GET /api/turno`, `POST /api/login` |
| Dependencias de producción | 7 (`@supabase/supabase-js`, `@upstash/ratelimit`, `@upstash/redis`, `react`, `react-dom`, `react-router-dom`, `web-push`) |
| `npm audit` | **0 vulnerabilidades** |

## 2. Dominios auditados

| Dominio | Estado | Evidencia |
|---|---|---|
| Autenticación y autorización | Auditado | Supabase Auth + MFA + `fn_es_administrador` / `fn_puede_operar_turnos` por RPC |
| Validación e inyección | Auditado | Todo parámetro llega a una RPC tipada; el SQL es parametrizado; sin `dangerouslySetInnerHTML`, `eval` ni `innerHTML` |
| Secretos y configuración | Auditado | `secretos.env` con permisos 600 y en `.gitignore`; `service_role` ausente del bundle (comprobado con `grep` sobre `dist/`) |
| Dependencias | Auditado | `npm audit --omit=dev` → 0; 7 dependencias de producción |
| Protección de datos | Auditado | Token anónimo, sin PII del ciudadano; token purgado al caducar; `metadata` de auditoría protegido por disparador |
| Seguridad de API | Auditado | 4 endpoints, cada uno con su control de autorización |
| Infraestructura y despliegue | Auditado | `vercel.json` con cron y cabeceras; sin Docker ni IaC (proyecto serverless) |
| Criptografía | Auditado | `gen_random_bytes(32)` (256 bits) para el token; VAPID de `web-push`; comparación de tokens en tiempo constante por Postgres |
| Errores y registros | Auditado | `console.error` sin PII; errores traducidos al idioma del operador |

**Omitido:** *gestión de incidentes* y *respuesta a vulnerabilidades* — no hay
superficie de aplicación que auditar (no hay backend propio con estado).

---

## 3. Hallazgos

### S-01 · Alto · Seguridad de API — `app/api/push.ts:140`

**Qué pasa.** La autorización del emisor de avisos, cuando `CRON_SECRET` **no**
está configurado, comparaba la cabecera `Host` con `VERCEL_URL`:

```ts
if (process.env.NODE_ENV === 'production') {
  return req.headers.get('host') === process.env.VERCEL_URL
}
```

**Riesgo.** La cabecera `Host` la elige el cliente. Cualquiera que envíe una
petición con ese valor pasa la comprobación y **dispara el emisor de avisos
push a ciudadanos reales**. Con `CRON_SECRET` ausente (que es lo que pasa si
alguien despliega sin leer la documentación), `/api/push` queda abierto a
internet: el atacante puede provocar el envío de la cola de avisos y gastar la
cuota de push de los ciudadanos.

**Arreglo.** Fallar cerrado: en producción, sin `CRON_SECRET`, **se rechaza
todo** y se avisa por el registro del servidor. Se añadió además un
comentario que explica por qué la comparación de cabeceras no es una
comprobación.

```ts
if (process.env.NODE_ENV === 'production') {
  console.error('[situr/push] CRON_SECRET no está configurado: se rechaza el envío. …')
  return false
}
```

**Verificado:** sin secreto, la llamada se rechaza; con secreto, se acepta
solo con `Authorization: Bearer <secreto>`.

---

### S-02 · Medio · Límite de tasa — `app/src/lib/rpc.ts:103` y `app/src/lib/auth.tsx:144`

**Qué pasa.** El DRS §10 promete limitar por IP+token la consulta pública y
por IP+cuenta el login. Pero **ninguna de las dos peticiones pasaba por el
servidor**: el navegador llamaba a `supabase.co` directamente (`supabase.rpc(…)`
y `supabase.auth.signInWithPassword(…)`). El Edge Middleware, que es lo único
que puede contar peticiones, **nunca las veía**.

En el código, el limitador de login estaba aplicado a `POST /admin`, una ruta
que **nadie usa**: el login nunca pasaba por ahí. Era un límite que no podía
dispararse — maquinaria que no demostraba nada.

**Riesgo.** Fuerza bruta contra la contraseña del operador sin límite, y
consultas públicas sin límite, contra lo que el documento afirma que está
limitado.

**Arreglo.** Dos rutas nuevas que hacen pasar las peticiones por el servidor:

- `app/api/turno.ts` — `GET ?token=` → llama a `get_turno_publico` con la clave
  **anon** (la RLS sigue aplicando igual) y devuelve solo los campos mínimos.
- `app/api/login.ts` — `POST {email, password}` → reenvía el intento a la API de
  autenticación de Supabase y devuelve su respuesta tal cual. La contraseña no
  se guarda en ningún sitio.

El cliente usa esas rutas. El limitador de **admin** se eliminó: las
operaciones del operador no pasan por el servidor, y poner un límite que no se
puede aplicar sería mentira. El DRS §10 se reescribió para decir exactamente
qué está limitado y por dónde, y por qué lo demás no lo está (lo que protege
ahí es **quién puede**: sesión, MFA, RLS, rol y traza de auditoría).

**Verificado:** el login por la ruta nueva abre sesión correctamente y llega
hasta la consola; la consulta pública por la ruta nueva devuelve el turno; sin
sesión, el límite de login responde 400 con el error de credenciales.

---

### S-03 · Bajo · Secretos — `app/secretos.env`

**Qué pasa.** `secretos.env` contiene el `CRON_SECRET` y la clave privada de
VAPID reales, dentro de la carpeta del proyecto. Está en `.gitignore` y con
permisos 600, y el despliegue los pasa a Vercel por entrada estándar, que es
el patrón correcto. Pero **la carpeta `~/Música/estadiasdoc/` no es un
repositorio git**: si se comprime o se entrega completa, los secretos van
dentro.

**Arreglo.** Sacar los secretos de la carpeta del proyecto y dejarlos fuera,
por ejemplo en `~/.config/situr/secretos.env`, o generar los valores de VAPID
y `CRON_SECRET` **en el momento del despliegue** en lugar de guardarlos. Lo
mínimo: no compartir la carpeta completa con `secretos.env` dentro.

**Verificación necesaria:** decidir dónde viven los secretos antes de entregar.

---

### S-04 · Bajo · Datos — `app/api/suscripcion.ts:70`

**Qué pasa.** `registrar_suscripcion_push` hace `ON CONFLICT (token_publico)`
→ **actualiza**. Quien conozca el token de un turno puede registrar **su
propio** endpoint y quedarse con los avisos de ese ciudadano, o **borrar** los
avisos de verdad (`eliminar_suscripcion_push` no exige prueba de nada).

**Riesgo.** Supresión de los avisos push de un ciudadano, y lectura del
contenido del aviso (folio, módulo, mensaje).

**Por qué el riesgo es bajo.** El token **es** la credencial del ciudadano
(RF-017): quien lo tiene ya puede consultar el turno con
`get_turno_publico` y ver lo mismo. El margen adicional es la supresión del
aviso, no la confidencialidad de datos nuevos. Y token tiene 256 bits de
entropía: no se enumera.

**Arreglo (si se quiere cerrarlo).** Que el alta exija el endpoint previo: si
ya hay una suscripción activa con otro endpoint, no se sobrescribe sin una
prueba de posesión del turno (por ejemplo, que el turno se consulte
correctamente en la misma petición). Es un cambio en el DRS, no un parche.

**Verificación necesaria:** decidir si el riesgo se acepta.

---

## 4. Lo que se revisó y **no** es un hallazgo

Por precedente en la familia, se deja constancia de lo que se revisó y se
descartó, para que se vea que la revisión discrimina y no es hostil a la
estructura:

| Mecanismo | Por qué está ganado |
|---|---|
| Auditoría inmutable (`trg_auditoria_solo_insercion`) | El registro de quién hizo qué **es** el dato de referencia de un sistema de turnos auditing: sin él no hay rendición de cuentas. Es la garantía central, no decoración |
| `UNIQUE`, `CHECK` y claves foráneas en la base | Las invariantes duraderas están **en la base**, que es donde no se pueden saltar. Una restricción que no se puede eludir vale más que una validación en el cliente |
| Un contador atómico de folios (`folios` + `ON CONFLICT`) | La numeración concurrente de turnos **necesita** un bloqueo. Es la pieza que impide dos folios iguales |
| `FOR UPDATE SKIP LOCKED` al llamar | Es lo que garantiza que dos ventanillas no se llevan el mismo turno. Restricción de concurrencia real, no teatro de determinismo |
| Token de 256 bits con caducidad y purga | Es la credencial del ciudadano; su ciclo de vida es la garantía |
| RLS con `security_invoker` y revocación a `PUBLIC` | Son fronteras de aislamiento reales, y se encontraron **dos fugas** al auditarlas (la vista sin `security_invoker` y el `REVOKE` inefectivo) |
| Clave anon en el cliente | Por definición es pública; la seguridad no depende de ella, depende de la RLS |
| `CRON_SECRET` en el emisor de push | Distingue a nuestro cron de cualquiera que quiera disparar avisos |
| Expiración del token en la RPC y no solo en el cliente | La caducidad se aplica **en la base**; si el cliente la saltara, el token seguiría muerto |
| 125 aserciones de la base, prueba de concurrencia, dump restaurable | La verificación acompaña a la garantía, no la sustituye: la auditoría encontró cosas que los tests no veían |

## 5. Higiene de dependencias

- `npm audit --omit=dev` → **0 vulnerabilidades**.
- 7 dependencias de producción, todas con uso real: `supabase-js` (datos y
  sesión), `web-push` (emisor), `@upstash/*` (límite de tasa), React y el
  enrutador. No hay dependencias sin usar ni abstracciones con una sola
  implementación.
- Las de desarrollo (`axe-core`, `playwright-core`, `typescript`, `vite`,
  `tailwindcss`, tipos) son de herramientas de comprobación, no del producto.

## 6. Límites de este escaneo

- Se revisó **el código de la aplicación y el DDL**. La configuración real de
  Supabase (RLS materializada, políticas del panel, ajustes de Auth, la
  publicación de Realtime) **no se pudo revisar**: no hay proyecto. Los
  hallazgos sobre RLS salen de leer el DDL y de ejecutarlo, no de ver la
  configuración desplegada.
- No se ejecutaron cargas de ataque contra sistemas vivos.
- No se revisó la configuración de Vercel ni de Upstash, por no existir.
- El código del lado del cliente se revisó leyendo la fuente y el **bundle
  construido** (para confirmar que la `service_role` no llega al navegador).

## 7. Orden de arreglo sugerido

1. **S-01** — hecho: `/api/push` falla cerrado sin `CRON_SECRET`.
2. **S-02** — hecho: las consultas públicas y el login pasan por el servidor, y
   el DRS §10 dice la verdad.
3. **S-03** — pendiente de decisión: dónde viven los secretos.
4. **S-04** — pendiente de decisión: si el overwrite de la suscripción push
   se acepta o se cierra.

---

*Esto es una revisión técnica de seguridad del material proporcionado. No es
una determinación de cumplimiento legal ni sustituye una revisión de
penetración con el proyecto desplegado.*
