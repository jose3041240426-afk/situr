#!/usr/bin/env bash
# ============================================================================
# SITUR — PostgREST para las pruebas locales.
#
# PostgREST es la capa que Supabase usa para hablar con PostgreSQL: es la
# que traduce `/rest/v1/rpc/una_función` a una llamada SQL y la que aplica
# la RLS según el JWT de la petición.
#
# En producción no hace falta esto: Supabase ya lo trae. Aquí se usa para
# probar la aplicación contra la base real, con la RLS real.
#
# Uso:  ./postgrest-local.sh <usuario@host:puerto/base>
# ============================================================================
set -euo pipefail

SECRETO='situr-pruebas-jwt-secreto-largo-suficiente-1234567890'
CONEXION="${1:?uso: ./postgrest-local.sh <usuario@host:puerto/base>}"
PUERTO="${PGRST_PORT:-3000}"
BINARIO="${PGRST_BIN:-/tmp/opencode/postgrest}"

if [ ! -x "$BINARIO" ]; then
  echo "No se encuentra PostgREST en $BINARIO" >&2
  echo "Descárgalo de https://github.com/PostgREST/postgrest/releases" >&2
  exit 1
fi

CONFIG="$(mktemp)"
trap 'rm -f "$CONFIG"' EXIT

cat > "$CONFIG" <<EOF
db-uri = "postgresql://$CONEXION"
db-schemas = "public"
db-anon-role = "anon"
db-authenticated-role = "authenticated"
jwt-secret = "$SECRETO"
server-port = $PUERTO
log-level = "error"
EOF

exec "$BINARIO" "$CONFIG"
