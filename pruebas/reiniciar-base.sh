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
# Si los stubs fallan, se muestra el error: un `>/dev/null` aquí deja el
# mensaje «fallaron los stubs» sin ninguna pista de por qué.
if ! salida=$(psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$DIR/00_stubs.sql" 2>&1); then
  rojo "  fallaron los stubs"
  printf '%s\n' "$salida" | tail -5
  exit 1
fi

# TODAS las migraciones del repositorio, con dos excepciones: la 07 (pg_cron)
# y la 08 (Realtime) son de Supabase —ni la extensión `pg_cron` ni el esquema
# `realtime` existen en un PostgreSQL normal— y en local el sistema funciona
# igual, porque el cron del push lo lleva Vercel.
#
# El resto hace falta entero: la 09 trae los turnos por lote y el aviso
# programado, la 10 y la 11 los límites de atención y de llamada, la 12 la
# consulta por código, la 14 el aviso a los próximos, la 16 y la 17 la
# preferencia de aviso y la 19 la paginación del historial. Con solo las
# seis primeras la aplicación arranca pero la consola falla en cuanto se
# emite un lote o se abre el historial.
for f in "$APP"/supabase/migrations/*.sql; do
  case "$(basename "$f")" in
    *_07_*|*_08_*) continue ;;
  esac
  if ! salida=$(psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$f" 2>&1); then
    rojo "  falló $(basename "$f")"
    printf '%s\n' "$salida" | tail -5
    exit 1
  fi
done

# El arnés enlaza el administrador al arrancar; si la base se recrea con el
# stack en marcha, ese enlace se ha perdido y hay que rehacerlo.
echo "==> Enlazando el administrador con la autenticación del arnés"
psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -c \
  "UPDATE usuarios SET auth_uid = '11111111-1111-1111-1111-111111111111'
   WHERE numero_empleado = 'EMP-0001';" >/dev/null

# PostgREST no vuelve a leer el esquema solo: guarda la caché en memoria y
# solo la recarga cuando se lo avisa. Al recrear la base, las RPC nuevas
# (preferencia de aviso, historial paginado, turnos por lote…) existen en
# PostgreSQL pero PostgREST sigue respondiendo «no la encuentro» con la
# caché de antes. Es el mismo aviso que da `levantar.sh` al montar el stack.
echo "==> Avisando a PostgREST de que recargue el esquema"
for i in $(seq 1 10); do
  psql -X -q -d "$BASE" -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true
  sleep 0.3
done

verde "  base '$BASE' lista"
