#!/usr/bin/env bash
# ============================================================================
# SITUR — Despliegue
#
# Hace, en orden, lo que hace falta para que el sistema quede sirviendo:
#
#   1. Comprueba que `secretos.env` está completo (sin REEMPLAZAR).
#   2. Aplica las migraciones al proyecto de Supabase (`supabase db push`).
#   3. Pasa las variables de entorno a Vercel, para producción y para
#      staging.
#   4. Despliega.
#
# Es idempotente: se puede volver a correr sin romper nada.
#
# La cuenta NO está atada al código: la URL y las claves se leen de
# `secretos.env`. Si el asesor decide que la cuenta definitiva es otra
# (punto 14 de PREGUNTAS_para_el_asesor.txt), se cambia el proyecto con
# `--proyecto=<ref>` y se vuelve a correr este mismo script.
#
# Requisitos: la CLI de Supabase (`npm i -g supabase`) y la de Vercel
# (`npm i -g vercel`), con `supabase link` y `vercel link` ya hechos.
#
# Uso:  scripts/desplegar.sh [--staging] [--saltar-migraciones]
#                                [--proyecto=<ref-supabase>]
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(dirname "$DIR")"
SECRETOS="$APP/secretos.env"

AMBIENTE="production"
SALTAR_MIGRACIONES=0
PROYECTO=""
for arg in "$@"; do
  case "$arg" in
    --staging) AMBIENTE="staging" ;;
    --proyecto=*) PROYECTO="${arg#--proyecto=}" ;;
    --saltar-migraciones) SALTAR_MIGRACIONES=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

rojo() { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
echo "SITUR — despliegue a $AMBIENTE"
echo "=============================================================="

# --- 1) Secretos ----------------------------------------------------------
if [ ! -f "$SECRETOS" ]; then
  rojo "Falta $SECRETOS"
  echo "  Genérelo con:  node scripts/generar-secretos.mjs" >&2
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
  echo "  Edite el archivo y vuelva a correr." >&2
  exit 1
fi
verde "Secretos completos."

# --- 2) Migraciones -------------------------------------------------------
if [ "$SALTAR_MIGRACIONES" -eq 0 ]; then
  if ! command -v supabase >/dev/null 2>&1; then
    rojo "Falta la CLI de Supabase:  npm i -g supabase"
    exit 1
  fi
  echo
  echo "==> Migraciones a Supabase"
  if [ -n "$PROYECTO" ]; then
    # Enlazar a otro proyecto es lo que hace falta cuando la cuenta
    # definitiva cambia (punto 14 de PREGUNTAS_para_el_asesor.txt).
    supabase link --project-ref "$PROYECTO"
  fi
  supabase db push --include-all
  verde "Migraciones aplicadas."
else
  echo "==> Migraciones omitidas (--saltar-migraciones)"
fi

# --- 3) Variables de entorno en Vercel ------------------------------------
if ! command -v vercel >/dev/null 2>&1; then
  rojo "Falta la CLI de Vercel:  npm i -g vercel"
  exit 1
fi

echo
echo "==> Variables de entorno en Vercel ($AMBIENTE)"

# Las que van al navegador: la clave anon y la pública de VAPID.
# Las del servidor: la service_role, la privada de VAPID y el CRON_SECRET.
# `vercel env add` con `--sensitive` marca las secretas, que Vercel no
# muestra en los logs de las funciones.
setvar() {
  local nombre="$1" valor="$2" sensible="$3"
  if [ "$sensible" = "sensible" ]; then
    printf '%s' "$valor" | vercel env add "$nombre" "$AMBIENTE" --sensitive --force >/dev/null
  else
    printf '%s' "$valor" | vercel env add "$nombre" "$AMBIENTE" --force >/dev/null
  fi
  echo "    $nombre"
}

setvar VITE_SUPABASE_URL        "$SUPABASE_URL"
setvar VITE_SUPABASE_ANON_KEY   "$SUPABASE_ANON_KEY"
setvar VITE_VAPID_PUBLIC_KEY    "$VAPID_PUBLIC_KEY"

setvar SUPABASE_URL             "$SUPABASE_URL" sensible
setvar SUPABASE_ANON_KEY        "$SUPABASE_ANON_KEY" sensible
setvar SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY" sensible
setvar VAPID_PUBLIC_KEY         "$VAPID_PUBLIC_KEY" sensible
setvar VAPID_PRIVATE_KEY        "$VAPID_PRIVATE_KEY" sensible
setvar VAPID_SUBJECT            "$VAPID_SUBJECT"
setvar CRON_SECRET              "$CRON_SECRET" sensible

# Upstash es opcional: sin él, el middleware deja pasar.
if [ -n "${UPSTASH_REDIS_REST_URL:-}" ] && [ "$UPSTASH_REDIS_REST_URL" != "REEMPLAZAR" ]; then
  setvar UPSTASH_REDIS_REST_URL  "$UPSTASH_REDIS_REST_URL" sensible
  setvar UPSTASH_REDIS_REST_TOKEN "${UPSTASH_REDIS_REST_TOKEN:-}" sensible
  verde "    Upstash configurado (límite de tasa activo)."
else
  echo "    Upstash sin configurar: el middleware no limitará (aceptable en el primer despliegue)."
fi

# --- 4) Despliegue --------------------------------------------------------
echo
echo "==> Despliegue"
cd "$APP"
vercel --prod --yes
verde "Desplegado."

echo
echo "=============================================================="
echo "Pasos que quedan a mano:"
echo "  1) node scripts/arrancar.mjs   → crea el administrador y lo enlaza"
echo "  2) Activar pg_cron en el panel de Supabase (Database > Extensions)"
echo "  3) Comprobar que el cron de Vercel corre:  el aviso de un turno"
echo "     cercano debe llegar en menos de un minuto"
