#!/usr/bin/env bash
# ============================================================================
# SITUR — Reinicia la base de datos local SIN tocar el stack.
#
#   pruebas/reiniciar-base.sh [base]
#
# Por qué existe: `levantar.sh` recrea la base, pero también reinicia el
# servidor de desarrollo (reescribe `.env.local`, y Vite se reinicia al
# detectarlo). Ese reinicio, con la aplicación recargándose y Vite
# transformando los 151 módulos otra vez, es el mayor pico de memoria de
# toda la operación: en una máquina con 8 GB el renderizador de Chromium se
# queda sin memoria y el recorrido del tutorial se cae a mitad.
#
# Aquí la base se recrea **en caliente**, con el stack ya en marcha: se
# borra, se vuelve a migrar y se vuelve a enlazar el administrador. Nada más
# se toca, y el servidor de desarrollo sigue caliente.
#
# Sale con 0 si todo va bien.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(dirname "$DIR")"
BASE="${1:-situr_tutorial}"

export PGHOST="${PGHOST:-127.0.0.1}"
export PGUSER="${PGUSER:-postgres}"

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }

if ! psql -X -q -d postgres -c "SELECT 1" >/dev/null 2>&1; then
  rojo "No hay PostgreSQL en $PGHOST con el rol $PGUSER"
  exit 1
fi

echo "==> Recreando la base '$BASE'"
# PostgREST tiene las conexiones abiertas: sin cerrarlas, el DROP falla con
# «la base está siendo utilizada por otros usuarios».
psql -X -q -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname = '$BASE' AND pid <> pg_backend_pid();" >/dev/null 2>&1
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $BASE;" >/dev/null
psql -X -q -d postgres -c "CREATE DATABASE $BASE;" >/dev/null
# El propio PostgreSQL avisa de que la version de ordenamiento de la base
# no coincide con la de la biblioteca. Se refresca y se calla el aviso.
psql -X -q -d postgres -c "ALTER DATABASE postgres REFRESH COLLATION VERSION;" >/dev/null 2>&1

echo "==> Aplicando el esquema y la semilla"
# Los stubs delante: los roles `anon`, `authenticated` y `service_role` y el
# esquema `auth` con `auth.uid()`, que en Supabase ya existen y en un
# PostgreSQL local no.
if ! psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$DIR/00_stubs.sql" >/dev/null 2>&1; then
  rojo "  fallaron los stubs"
  exit 1
fi
for f in "$APP"/supabase/migrations/*_0[1-6]_*.sql; do
  if ! psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$f" >/dev/null 2>&1; then
    rojo "  falló $(basename "$f")"
    exit 1
  fi
done

# El arnés enlaza el administrador al arrancar; si la base se recrea con el
# stack en marcha, ese enlace se ha perdido y hay que rehacerlo.
echo "==> Enlazando el administrador con la autenticación del arnés"
psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -c \
  "UPDATE usuarios SET auth_uid = '11111111-1111-1111-1111-111111111111'
   WHERE numero_empleado = 'EMP-0001';" >/dev/null

verde "  base '$BASE' lista"
