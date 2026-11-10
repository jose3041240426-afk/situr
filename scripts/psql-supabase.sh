#!/usr/bin/env bash
# ============================================================================
# SITUR — Abrir una sesión SQL contra la base de Supabase
#
#   scripts/psql-supabase.sh                 # sesión interactiva
#   scripts/psql-supabase.sh -c "select 1"   # una consulta
#   echo "select 1" | scripts/psql-supabase.sh
#
# Es el atajo de todos los días: en vez de recordar el host del pooler, el
# usuario y de dónde sale la contraseña, se lee el archivo de credenciales que
# vive FUERA del repositorio (`../secretos-bd.env`, permisos 600) y se llama a
# psql con la contraseña en `PGPASSWORD` —nunca dentro de la URL, para que no
# aparezca en la lista de procesos—.
#
# Lo que se escribe aquí va contra PRODUCCIÓN. No hay copia intermedia: si se
# borra una fila, se borra de verdad. Las migraciones van por
# `scripts/conectar-supabase.sh`, que es idempotente.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(dirname "$DIR")"
CREDENCIALES="$(dirname "$APP")/secretos-bd.env"

rojo() { printf '\033[31m%s\033[0m\n' "$1"; }

if [ ! -f "$CREDENCIALES" ]; then
  rojo "Falta $CREDENCIALES"
  echo "  Es el archivo con SUPABASE_DB_PASSWORD y SUPABASE_PROJECT_REF." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$CREDENCIALES"

if [ -z "${SUPABASE_DB_PASSWORD:-}" ] && [ -z "${SUPABASE_DB_URL:-}" ]; then
  rojo "El archivo de credenciales no tiene contraseña ni cadena de conexión."
  exit 1
fi

# La contraseña va por entorno, no en la URL.
if [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  export PGPASSWORD="$SUPABASE_DB_PASSWORD"
fi

if [ -n "${SUPABASE_DB_URL:-}" ]; then
  CONEXION="$SUPABASE_DB_URL"
elif [ -n "${SUPABASE_DB_HOST:-}" ]; then
  CONEXION="postgresql://${SUPABASE_DB_USER:-postgres.${SUPABASE_PROJECT_REF}}@${SUPABASE_DB_HOST}:5432/postgres"
else
  CONEXION="postgresql://postgres@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres"
fi

# `-X`: sin archivo de inicio del usuario, para que el resultado no dependa de
# la configuración de cada máquina.
exec psql -X "$CONEXION" "$@"
