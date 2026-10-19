# SITUR en Supabase

Esta carpeta es la que usa la CLI de Supabase:

```bash
supabase link --project-ref <ref-del-proyecto>
supabase db push          # aplica las migraciones al proyecto
supabase db reset         # base local limpia + seed
```

## Qué hay aquí

| Archivo | Para qué |
|---|---|
| `config.toml` | Configuración del proyecto: puerto, JWT, MFA obligatorio, semilla |
| `migrations/` | Las 8 migraciones, con los nombres y las fechas que espera la CLI |
| `seed.sql` | Los catálogos y la configuración (idempotente) |

## Diferencia con `../../migracion/`

Las migraciones de `supabase/migrations/` son **las mismas** que las de
`../../migracion/`, con una excepción:

**No se incluye `00_stubs.sql`.** Ese archivo es solo para PostgreSQL local:
crea el esquema `auth`, el stub de `auth.uid()`, y los roles `anon`,
`authenticated` y `service_role`. En Supabase **todo eso ya existe**, y
volver a crearlo sería un error.

Por eso en Supabase:

- `auth.uid()` es el de verdad: lee el JWT de la petición.
- `005_rls_policies.sql` encuentra los roles (`IF EXISTS (SELECT 1 FROM
  pg_roles ...)`) y aplica sus `REVOKE` y `GRANT` sobre ellos.

## Orden de las migraciones

| # | Archivo | Qué hace |
|---|---|---|
| 01 | `initial_schema` | 12 tablas, 5 ENUM, restricciones |
| 02 | `indexes` | 18 índices (los que aportan; las FK ya crean los suyos) |
| 03 | `views` | 5 vistas de lectura, incluida la de seguimiento ciudadano |
| 04 | `functions_rpc` | 30 funciones: el catálogo de RPC |
| 05 | `rls_policies` | 18 políticas, 3 disparadores, los privilegios por objeto |
| 06 | `seed_data` | Roles, trámites, módulos, configuración, administrador |
| 07 | `pg_cron` | El timeout automático de `CALLED` (requiere activar `pg_cron`) |
| 08 | `supabase_realtime` | Publica `turnos` y difunde el cambio al canal del ciudadano |

> **La 07 necesita la extensión `pg_cron` activada** en el panel de Supabase
> (Database → Extensions) antes de aplicarse. Si no está, `CREATE EXTENSION`
> falla y la migración se detiene — que es lo correcto: mejor que se note
> que un timeout que no existe.

> **La 08 es opcional.** La aplicación no depende de Realtime: el panel
> refresca cada 15 s y el portal del ciudadano sondea cada 10 s. Realtime solo
> lo hace inmediato. Si prefieres que el aviso llegue al instante sin
> esperar al sondeo, aplícala.

## Cómo se prueban sin Supabase

Ni `pg_cron` ni el esquema `realtime` existen en un PostgreSQL normal, pero
**el SQL y la lógica de los dos archivos sí se pueden comprobar**. Para eso
está `migracion/prueba/probar-supabase.sh`, que sustituye esas dos piezas por
simulacros equivalentes y verifica:

- que 007 aplica y programa el cron con la expresión correcta;
- que 008 aplica y crea el disparador de difusión;
- que el disparador **solo** difunde cuando cambia el estado del turno (y no
  cuando se actualiza `token_ultimo_acceso`, que escribe la propia consulta
  ciudadana);
- que la difusión va al canal `turno:{token}` y lleva el motivo del cambio.

```bash
migracion/prueba/probar-supabase.sh situr_sb
```

Lo que **no** cubre, y solo se ve en Supabase: que la extensión esté de
verdad instalada y el cron corra, que `realtime.send()` difunda al canal
privado, y que exista la publicación `supabase_realtime`.

## Lo que la CLI no puede hacer

El usuario del administrador se crea en **Supabase Auth**, fuera de la base.
Por eso, después de `supabase db push`, hay que correr:

```bash
node ../scripts/arrancar.mjs
```

que crea el usuario en Auth y escribe su `auth_uid` en `usuarios`. Es el
mismo enlace del que habla el DRS en RF-003 y en §6: sin él, el registro
existe pero no hay sesión ni RLS que lo deje pasar.
