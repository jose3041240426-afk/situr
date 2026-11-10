#!/usr/bin/env bash
# ============================================================================
# SITUR — Subir la aplicación a Vercel
#
#   scripts/subir-vercel.sh [--staging] [--sin-env] [--dry-run]
#
#   1. Comprueba la CLI de Vercel y la sesión.
#   2. Enlaza el proyecto (si no hay `.vercel/`).
#   3. Pasa a Vercel las variables de `secretos.env`: las públicas para el
#      navegador y las secretas con `--sensitive`.
#   4. Despliega (producción por defecto, o preview con `--staging`).
#
# Es idempotente: las variables se sobrescriben (`--force`) y el despliegue
# solo cambia lo que haya cambiado.
#
# OPCIONES
#   --staging    Despliegue de previsualización en vez de producción.
#   --sin-env    No toca las variables (solo despliega).
#   --dry-run    Muestra lo que haría, sin tocar Vercel.
#
# QUÉ HACE FALTA
#   · La CLI de Vercel:   npm i -g vercel
#   · Una sesión:         vercel login
#   · `secretos.env`:     node scripts/generar-secretos.mjs
#
# DESPUÉS
#   node scripts/arrancar.mjs   crea el administrador en Supabase Auth y lo
#   enlaza con `usuarios.auth_uid` (eso no lo puede hacer Vercel).
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(dirname "$DIR")"
SECRETOS="$APP/secretos.env"

AMBIENTE="production"
TOCAR_ENV=1
DRY=0

rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }
gris()  { printf '\033[90m%s\033[0m\n' "$1"; }

for arg in "$@"; do
  case "$arg" in
    --staging)  AMBIENTE="preview" ;;
    --sin-env)  TOCAR_ENV=0 ;;
    --dry-run)  DRY=1 ;;
    -h|--help)  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) rojo "Opción desconocida: $arg"; exit 1 ;;
  esac
done

echo "SITUR — despliegue a Vercel ($AMBIENTE)"
echo "=============================================================="

if ! command -v vercel >/dev/null 2>&1; then
  rojo "Falta la CLI de Vercel."
  echo "  Instálala con:  npm i -g vercel" >&2
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  rojo "La CLI no tiene sesión."
  echo "  Inicia sesión con:  vercel login" >&2
  exit 1
fi
verde "CLI de Vercel con sesión: $(vercel whoami 2>/dev/null)"

# ---------------------------------------------------------------------------
# 1. Variables de entorno
# ---------------------------------------------------------------------------
if [ "$TOCAR_ENV" -eq 1 ]; then
  if [ ! -f "$SECRETOS" ]; then
    rojo "Falta $SECRETOS"
    echo "  Genéralo con:  node scripts/generar-secretos.mjs" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  set -a; . "$SECRETOS"; set +a

  FALTAN=()
  for v in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
           VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY CRON_SECRET; do
    valor="${!v:-}"
    if [ -z "$valor" ] || [ "$valor" = "REEMPLAZAR" ]; then
      FALTAN+=("$v")
    fi
  done
  if [ ${#FALTAN[@]} -gt 0 ]; then
    rojo "Faltan estos valores en secretos.env: ${FALTAN[*]}"
    echo "  Edita el archivo y vuelve a correr." >&2
    exit 1
  fi

  echo
  echo "==> Variables de entorno ($AMBIENTE)"

  # Las que ve el navegador (públicas) y las del servidor (secretas).
  # `--sensitive` evita que Vercel las muestre en los logs de las funciones.
  setvar() {
    local nombre="$1" valor="$2" sensible="${3:-}"
    if [ "$DRY" -eq 1 ]; then
      gris "    (dry-run) $nombre"
      return
    fi
    if [ "$sensible" = "sensible" ]; then
      printf '%s' "$valor" | vercel env add "$nombre" "$AMBIENTE" --sensitive --force >/dev/null
    else
      printf '%s' "$valor" | vercel env add "$nombre" "$AMBIENTE" --force >/dev/null
    fi
    echo "    $nombre"
  }

  setvar VITE_SUPABASE_URL         "$SUPABASE_URL"
  setvar VITE_SUPABASE_ANON_KEY    "$SUPABASE_ANON_KEY"
  setvar VITE_VAPID_PUBLIC_KEY     "$VAPID_PUBLIC_KEY"

  setvar SUPABASE_URL              "$SUPABASE_URL" sensible
  setvar SUPABASE_ANON_KEY         "$SUPABASE_ANON_KEY" sensible
  setvar SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY" sensible
  setvar VAPID_PUBLIC_KEY          "$VAPID_PUBLIC_KEY" sensible
  setvar VAPID_PRIVATE_KEY         "$VAPID_PRIVATE_KEY" sensible
  setvar VAPID_SUBJECT             "${VAPID_SUBJECT:-mailto:catastro@durango.gob.mx}"
  setvar CRON_SECRET               "$CRON_SECRET" sensible

  # Upstash es opcional: sin él, el middleware deja pasar (primer despliegue).
  if [ -n "${UPSTASH_REDIS_REST_URL:-}" ] && [ "$UPSTASH_REDIS_REST_URL" != "REEMPLAZAR" ]; then
    setvar UPSTASH_REDIS_REST_URL   "$UPSTASH_REDIS_REST_URL" sensible
    setvar UPSTASH_REDIS_REST_TOKEN "${UPSTASH_REDIS_REST_TOKEN:-}" sensible
    verde "    Upstash configurado (límite de tasa activo)."
  else
    gris "    Upstash sin configurar: el middleware no limitará la tasa."
  fi
else
  echo "==> Variables omitidas (--sin-env)"
fi

# ---------------------------------------------------------------------------
# 2. Despliegue
# ---------------------------------------------------------------------------
echo
if [ ! -d "$APP/.vercel" ]; then
  echo "==> Enlazando el proyecto (no hay .vercel/)"
  if [ "$DRY" -eq 1 ]; then
    gris "    (dry-run) vercel link --yes"
  else
    (cd "$APP" && vercel link --yes)
  fi
fi

echo "==> Desplegando"
if [ "$DRY" -eq 1 ]; then
  if [ "$AMBIENTE" = "production" ]; then
    gris "    (dry-run) vercel --prod --yes"
  else
    gris "    (dry-run) vercel --yes"
  fi
  exit 0
fi

cd "$APP"
if [ "$AMBIENTE" = "production" ]; then
  salida=$(vercel --prod --yes 2>&1 | tail -3)
else
  salida=$(vercel --yes 2>&1 | tail -3)
fi
printf '%s\n' "$salida"
verde "Desplegado."

echo
echo "=============================================================="
echo "Lo que queda a mano:"
echo "  1) node scripts/arrancar.mjs   → crea el administrador y lo enlaza"
echo "  2) Comprueba que el cron de Vercel corre (cada minuto, /api/push)"
echo "  3) Abre la URL del despliegue y entra con la cuenta de operador"
