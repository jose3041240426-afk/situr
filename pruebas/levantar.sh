#!/usr/bin/env bash
# ============================================================================
# SITUR — Levanta el stack local completo.
#
# Deja funcionando, contra una base PostgreSQL real:
#
#   :3000   PostgREST   (la API de datos: RPC, vistas, RLS)
#   :9999   GoTrue      (el login, propio del arnés)
#   :54321  proxy       (/rest/v1 -> 3000, /auth/v1 -> 9999)
#
# Antes de arrancar, **para lo que hubiera de una corrida anterior**: es
# exactamente el error que hace que la aplicación termine hablando con la
# base equivocada sin avisar.
#
# Uso:
#   pruebas/levantar.sh [base] [puerto-proxy]
#   pruebas/levantar.sh situr_e2e
#
# Dejar en marcha:  Ctrl-C
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(dirname "$DIR")"
MIG="$APP/../migracion"

BASE="${1:-situr_app}"
PUERTO_PROXY="${2:-54321}"
PUERTO_PGRST="${PGRST_PORT:-3000}"
PGRST_BIN="${PGRST_BIN:-/tmp/opencode/postgrest}"

rojo() { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }

export PGHOST="${PGHOST:-127.0.0.1}"
export PGUSER="${PGUSER:-postgres}"

# --- 0) Limpiar lo que hubiera --------------------------------------------
echo "==> Parando los procesos de una corrida anterior"
# Ojo: `postgrest-local.sh` hace `exec` del binario, así que el proceso que
# queda en marcha se llama `postgrest`, no `postgrest-local.sh`, y su
# configuración es un archivo temporal SIN extensión. Hay que cazarlo por la
# ruta del binario, o el PostgREST viejo sigue sirviendo OTRA base.
PATRONES=("arnes-local.mjs" "postgrest-local.sh" "$PGRST_BIN")
for patron in "${PATRONES[@]}"; do
  for pid in $(pgrep -f "$patron" 2>/dev/null); do
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo "")
    case "$cmd" in
      node*|*postgrest*) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
done
sleep 1

# Si los puertos siguen ocupados, hay algo que no es nuestro: seguir sería
# acabar probando contra la base equivocada.
for puerto in "$PUERTO_PROXY" "$PUERTO_PGRST" 9999; do
  if ss -ltn 2>/dev/null | grep -q ":$puerto "; then
    rojo "El puerto $puerto sigue ocupado por un proceso que no es de este script."
    echo "  Identifíquelo y párelo antes de seguir:" >&2
    ss -ltnp 2>/dev/null | grep ":$puerto " >&2
    exit 1
  fi
done

if [ ! -x "$PGRST_BIN" ]; then
  rojo "Falta el binario de PostgREST en $PGRST_BIN"
  echo "  Descárgalo una vez:" >&2
  echo "  curl -sSL -o /tmp/opencode/pgrst.tar.xz https://github.com/PostgREST/postgrest/releases/download/v16.4/postgrest-v16.4-linux-static-x86-64.tar.xz" >&2
  echo "  tar -xJf /tmp/opencode/pgrst.tar.xz -C /tmp/opencode" >&2
  exit 1
fi

# --- 1) Base de datos ------------------------------------------------------
echo "==> Preparando la base '$BASE'"
if psql -X -q -d postgres -c "SELECT 1" >/dev/null 2>&1; then
  psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $BASE;" >/dev/null 2>&1 || true
  psql -X -q -d postgres -c "CREATE DATABASE $BASE;" >/dev/null 2>&1 || true
  if [ -d "$MIG" ]; then
    # Proyecto completo: se usa la carpeta hermana, que además trae la suite.
    bash "$MIG/aplicar.sh" "$BASE" >/dev/null 2>&1 && verde "   migrada" || rojo "   la migración falló"
  else
    # Solo este repositorio: se aplican las migraciones que trae, en orden,
    # con los stubs de `pruebas/00_stubs.sql` delante (los roles `anon` y
    # `authenticated` y el esquema `auth`, que en Supabase ya existen).
    #
    # Las de `007` (pg_cron) y `008` (Realtime) son de Supabase: en local se
    # saltan, y el sistema funciona igual (el cron del push es de Vercel).
    echo "   aplicando las migraciones de supabase/migrations/…"
    if psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$DIR/00_stubs.sql" >/dev/null 2>&1 &&
       for f in "$APP"/supabase/migrations/*_0[1-6]_*.sql; do
         psql -X -q -v ON_ERROR_STOP=1 -d "$BASE" -f "$f" >/dev/null 2>&1 || {
           rojo "   falló $f"; exit 1;
         }
       done; then
      verde "   migrada"
    else
      rojo "   la migración falló"
      exit 1
    fi
  fi
else
  rojo "No hay PostgreSQL en $PGHOST con el rol $PGUSER"
  exit 1
fi

# --- 2) PostgREST ----------------------------------------------------------
echo "==> PostgREST en :$PUERTO_PGRST"
"$DIR/postgrest-local.sh" "$PGUSER@127.0.0.1:5432/$BASE" >/tmp/opencode/postgrest.log 2>&1 &
PGRST_PID=$!

# PostgREST guarda en memoria el esquema de la base y **no lo vuelve a leer
# solo**: una función nueva no aparece hasta que se recarga. Sin esto, la
# RPC se crea bien en PostgreSQL pero PostgREST responde «no la encuentro en
# la caché», y parece que la RPC está mal cuando lo que está desfasado es
# PostgREST. Se recarga y se espera a que esté lista.
for i in $(seq 1 20); do
  psql -X -q -d "$BASE" -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true
  sleep 0.3
done

# --- 3) Arnés (auth + proxy) ----------------------------------------------
echo "==> Arnés de auth y proxy en :$PUERTO_PROXY"
node "$DIR/arnes-local.mjs" "postgresql://$PGUSER@127.0.0.1:5432/$BASE" "$PUERTO_PROXY" >/tmp/opencode/arnes.log 2>&1 &
ARNES_PID=$!

# --- 4) Esperar a que estén los dos ---------------------------------------
echo "==> Esperando a que respondan"
listo=0
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$PUERTO_PROXY/" 2>/dev/null; then listo=1; break; fi
  # Si el arnés se murió, no hay que esperar 30 segundos para enterarse.
  if ! kill -0 $ARNES_PID 2>/dev/null; then break; fi
  sleep 1
done

if [ "$listo" -ne 1 ]; then
  rojo "El stack no arrancó. Logs:"
  echo "--- postgrest ---"; tail -15 /tmp/opencode/postgrest.log
  echo "--- arnés ---";    tail -15 /tmp/opencode/arnes.log
  exit 1
fi

ANON_KEY=$(grep ANON_KEY /tmp/opencode/arnes.log 2>/dev/null | cut -d= -f2)
SERVICE_ROLE=$(grep SERVICE_ROLE_KEY /tmp/opencode/arnes.log 2>/dev/null | cut -d= -f2)
if [ -z "$ANON_KEY" ] || [ -z "$SERVICE_ROLE" ]; then
  rojo "El arnés no arrancó. Log:"
  tail -20 /tmp/opencode/arnes.log
  exit 1
fi

verde "Todo en pie."
echo
echo "  Base      : $BASE"
echo "  API       : http://127.0.0.1:$PUERTO_PROXY"

# --- 5) Apuntar la aplicación al arnés -------------------------------------
# Se escribe el `.env.local` con las variables PUBLICAS. Lo que el navegador
# no puede ver (la service_role, el VAPID privado, el CRON_SECRET) NO se
# copia: el servidor los toma de `secretos.env`.
cat > "$APP/.env.local" <<EOF
# Generado por pruebas/levantar.sh — apunta al arnés local.
#
# Las variables VITE_* van al navegador. Las de SUPABASE_* NO: Vite solo
# expone al bundle las que empiezan por VITE_, así que la service_role se
# queda en el servidor (lo comprueba `npm run build` con un grep sobre dist/).
VITE_SUPABASE_URL=http://127.0.0.1:$PUERTO_PROXY
VITE_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_URL=http://127.0.0.1:$PUERTO_PROXY
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE
EOF

# La clave publica de VAPID SI va en el navegador (la necesita para
# suscribirse), asi que se lee de `secretos.env`. Sin ella, el boton de
# avisos existe pero la suscripcion falla.
VAPID_PUB=""
if [ -f "$APP/secretos.env" ]; then
  VAPID_PUB=$(grep -E '^VAPID_PUBLIC_KEY=' "$APP/secretos.env" | cut -d= -f2-)
fi
if [ -n "$VAPID_PUB" ]; then
  echo "VITE_VAPID_PUBLIC_KEY=$VAPID_PUB" >> "$APP/.env.local"
else
  echo "  (aviso: no hay VAPID_PUBLIC_KEY en secretos.env; los avisos push no funcionaran)"
fi

echo "  .env.local escrito con la ANON_KEY del arnés"
echo
echo "Ya puedes arrancar la aplicación en otra terminal:"
echo
echo "    cd '$APP' && npm run dev"
echo
echo "Y entrar con:"
echo "    admin@situr.local / situr-admin-2026    (MFA: 123456)"

# --- 6) Esperar a que los paren --------------------------------------------
trap 'echo; echo "==> Parando"; kill -9 $PGRST_PID $ARNES_PID 2>/dev/null || true; exit 0' INT TERM
wait
