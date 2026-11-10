#!/usr/bin/env bash
# ============================================================================
# SITUR — Conectar con la base de datos de Supabase
#
#   scripts/conectar-supabase.sh --proyecto=<ref> [opciones]
#
# Deja el proyecto de Supabase listo para que la aplicación funcione:
#
#   1. Comprueba la CLI y la sesión (o usa `psql`, si se da `--db-url`).
#   2. Enlaza este repositorio con el proyecto (`supabase link`).
#   3. Aplica las 20 migraciones de `supabase/migrations/`, en orden.
#   4. Siembra los catálogos con `supabase/seed.sql` (idempotente).
#   5. Comprueba que la base responde y que tiene el esquema de hoy.
#
# Todo es idempotente: se puede volver a correr sin romper nada.
#
# OPCIONES
#   --proyecto=<ref>   Referencia del proyecto (Project Settings → General).
#                      También vale SUPABASE_PROJECT_REF.
#   --db-url=<url>     Cadena de conexión (Project Settings → Database).
#                      Sin ella se usa la CLI, que pide la contraseña.
#                      También vale SUPABASE_DB_URL.
#   --sin-semilla      No aplica `supabase/seed.sql` (base con datos reales).
#   --solo-comprobar   No aplica nada: enlaza, comprueba y sale.
#   --dry-run          Muestra lo que haría, sin tocar la base.
#
# QUÉ HACE FALTA
#   · La CLI de Supabase:  npm i -g supabase
#   · Una sesión:          supabase login    (o SUPABASE_ACCESS_TOKEN)
#   · O bien `psql` y una `--db-url` (no hace falta la CLI ni el login).
#
# DESPUÉS
#   Copia en `secretos.env` (o en Vercel) la URL y las claves del proyecto:
#   Project Settings → API. `scripts/desplegar.sh` las lee de ahí.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(dirname "$DIR")"
MIGRACIONES="$APP/supabase/migrations"
SEMILLA="$APP/supabase/seed.sql"

PROYECTO="${SUPABASE_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
SEMILLA_ON=1
SOLO_COMPROBAR=0
DRY=0

rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }
gris()  { printf '\033[90m%s\033[0m\n' "$1"; }

for arg in "$@"; do
  case "$arg" in
    --proyecto=*)   PROYECTO="${arg#--proyecto=}" ;;
    --db-url=*)     DB_URL="${arg#--db-url=}" ;;
    --sin-semilla)  SEMILLA_ON=0 ;;
    --solo-comprobar) SOLO_COMPROBAR=1 ;;
    --dry-run)      DRY=1 ;;
    -h|--help)      sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) rojo "Opción desconocida: $arg"; exit 1 ;;
  esac
done

echo "SITUR — conexión con Supabase"
echo "=============================================================="

if [ -z "$PROYECTO" ] && [ -z "$DB_URL" ]; then
  rojo "Falta el proyecto."
  echo "  Uso: scripts/conectar-supabase.sh --proyecto=<ref>" >&2
  echo "  El <ref> está en Project Settings → General → Reference ID." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Motor: la CLI de Supabase (preferida) o psql con una cadena de conexión
# ---------------------------------------------------------------------------
USAR_CLI=0
if command -v supabase >/dev/null 2>&1; then
  USAR_CLI=1
elif [ -z "$DB_URL" ]; then
  rojo "No hay CLI de Supabase ni cadena de conexión."
  echo "  Instala la CLI:      npm i -g supabase" >&2
  echo "  o pasa --db-url=postgres://postgres:<clave>@db.<ref>.supabase.co:5432/postgres" >&2
  exit 1
fi

if [ "$USAR_CLI" -eq 1 ]; then
  if ! supabase projects list >/dev/null 2>&1; then
    rojo "La CLI no tiene sesión."
    echo "  Inicia sesión con:   supabase login" >&2
    echo "  (o exporta SUPABASE_ACCESS_TOKEN con un token de acceso personal)" >&2
    exit 1
  fi
  verde "CLI de Supabase con sesión."
else
  if ! command -v psql >/dev/null 2>&1; then
    rojo "No hay psql."
    echo "  Instálalo (postgresql-client) o usa la CLI de Supabase." >&2
    exit 1
  fi
  verde "Sin CLI: se aplicará con psql sobre la cadena de conexión."
fi

# ---------------------------------------------------------------------------
# 2. Enlace del proyecto
# ---------------------------------------------------------------------------
if [ -n "$PROYECTO" ]; then
  echo
  echo "==> Enlazando el proyecto $PROYECTO"
  if [ "$DRY" -eq 1 ]; then
    gris "    (dry-run) supabase link --project-ref $PROYECTO"
  elif [ "$USAR_CLI" -eq 1 ]; then
    supabase link --project-ref "$PROYECTO"
  else
    gris "    sin CLI: el enlace no hace falta con --db-url"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Migraciones
# ---------------------------------------------------------------------------
echo
if [ "$SOLO_COMPROBAR" -eq 1 ]; then
  echo "==> Migraciones omitidas (--solo-comprobar)"
elif [ "$USAR_CLI" -eq 1 ]; then
  echo "==> Aplicando las migraciones (supabase db push)"
  if [ "$DRY" -eq 1 ]; then
    supabase db push --include-all --dry-run
  else
    # `--include-all` aplica también las que no están en el historial remoto
    # (por ejemplo, si el proyecto se creó a mano).
    supabase db push --include-all
  fi
  verde "    migraciones aplicadas"
else
  echo "==> Aplicando las migraciones con psql"
  # Se aplican TODAS, incluidas la 007 (pg_cron) y la 008 (Realtime): en
  # Supabase las dos tienen sentido. Si alguna falla por no estar habilitada
  # la extensión, el error lo dice y se arregla en el panel.
  for f in "$MIGRACIONES"/*.sql; do
    nombre=$(basename "$f")
    if [ "$DRY" -eq 1 ]; then
      gris "    (dry-run) $nombre"
      continue
    fi
    if ! salida=$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB_URL" -f "$f" 2>&1); then
      rojo "    falló $nombre"
      printf '%s\n' "$salida" | tail -8
      exit 1
    fi
    echo "    $nombre"
  done
  verde "    migraciones aplicadas"
fi

# ---------------------------------------------------------------------------
# 4. Semilla
# ---------------------------------------------------------------------------
echo
if [ "$SOLO_COMPROBAR" -eq 1 ]; then
  echo "==> Semilla omitida (--solo-comprobar)"
elif [ "$SEMILLA_ON" -eq 0 ]; then
  echo "==> Semilla omitida (--sin-semilla)"
elif [ -z "$DB_URL" ]; then
  echo "==> Semilla: `supabase db push` no la aplica en remoto"
  gris "    repite con --db-url=... para sembrar los catálogos,"
  gris "    o pégala a mano en el SQL Editor del panel"
elif [ "$DRY" -eq 1 ]; then
  gris "    (dry-run) psql -f supabase/seed.sql"
else
  echo "==> Sembrando catálogos y configuración"
  if ! salida=$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB_URL" -f "$SEMILLA" 2>&1); then
    rojo "    la semilla falló"
    printf '%s\n' "$salida" | tail -8
    exit 1
  fi
  verde "    semilla aplicada (es idempotente)"
fi

# ---------------------------------------------------------------------------
# 5. Comprobación: la base responde y tiene el esquema de hoy
# ---------------------------------------------------------------------------
echo
echo "==> Comprobando la base"
if [ "$DRY" -eq 1 ]; then
  gris "    (dry-run) sin comprobación"
elif [ -z "$DB_URL" ]; then
  gris "    sin --db-url no se puede comprobar desde aquí;"
  gris "    abre el SQL Editor del panel y ejecuta:  select * from vista_cola_espera;"
else
  if ! salida=$(psql -X -tAq -v ON_ERROR_STOP=1 -d "$DB_URL" <<'SQL' 2>&1
SELECT
    (SELECT count(*) FROM tramites)      || ' trámites, ' ||
    (SELECT count(*) FROM modulos)       || ' módulos, ' ||
    (SELECT count(*) FROM configuracion) || ' parámetros, ' ||
    (SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'turnos' AND column_name = 'reclamado_en')
    || ' (1 = esquema al día)';
SQL
  ); then
    rojo "    la comprobación falló"
    printf '%s\n' "$salida" | tail -8
    exit 1
  fi
  verde "    $salida"
fi

echo
echo "=============================================================="
echo "Lo que queda a mano:"
echo "  1) Copia la URL y las claves (Project Settings → API) en secretos.env"
echo "     o pásalas con scripts/desplegar.sh."
echo "  2) node scripts/arrancar.mjs   → crea el administrador y lo enlaza"
echo "  3) Activa pg_cron en el panel (Database → Extensions) si quieres el"
echo "     timeout automático de los turnos llamados."
echo "  4) Despliega con: scripts/desplegar.sh"
