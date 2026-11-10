#!/usr/bin/env bash
# ============================================================================
# SITUR — Poner el sistema a servir: base de datos y aplicación
#
#   scripts/desplegar.sh [opciones]
#
# Hace las dos cosas en orden, delegando en los dos scripts que las saben
# hacer por separado:
#
#   1. `conectar-supabase.sh` → enlaza el proyecto, aplica las 20 migraciones,
#      siembra los catálogos y comprueba que la base responde.
#   2. `subir-vercel.sh`      → pasa las variables de `secretos.env` a Vercel
#      y despliega.
#
# Antes comprobaba las dos cosas él mismo y duplicaba la lista de variables;
# al añadir una migración o una variable había que acordarse de tres sitios.
# Ahora cada paso vive en su script y este solo los encadena.
#
# OPCIONES
#   --proyecto=<ref>  Referencia del proyecto de Supabase (o SUPABASE_PROJECT_REF).
#   --db-url=<url>    Cadena de conexión (o SUPABASE_DB_URL).
#   --staging         Despliegue de previsualización en Vercel.
#   --saltar-base     No toca Supabase (solo despliega).
#   --saltar-vercel   No despliega (solo prepara la base).
#   --sin-semilla     No aplica `supabase/seed.sql`.
#   --dry-run         Muestra lo que haría, sin tocar nada.
#
# QUÉ HACE FALTA
#   · `secretos.env`:   node scripts/generar-secretos.mjs
#   · CLI de Supabase:  npm i -g supabase     (o pasar --db-url)
#   · CLI de Vercel:    npm i -g vercel
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROYECTO=""
DB_URL=""
AMBIENTE=""
SALTAR_BASE=0
SALTAR_VERCEL=0
SIN_SEMILLA=0
DRY=""

rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }

for arg in "$@"; do
  case "$arg" in
    --proyecto=*)     PROYECTO="${arg#--proyecto=}" ;;
    --db-url=*)       DB_URL="${arg#--db-url=}" ;;
    --staging)        AMBIENTE="--staging" ;;
    --saltar-base|--saltar-migraciones) SALTAR_BASE=1 ;;
    --saltar-vercel)  SALTAR_VERCEL=1 ;;
    --sin-semilla)    SIN_SEMILLA=1 ;;
    --dry-run)        DRY="--dry-run" ;;
    -h|--help)        sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) rojo "Opción desconocida: $arg"; exit 1 ;;
  esac
done

echo "SITUR — despliegue completo"
echo "=============================================================="

# ---------------------------------------------------------------------------
# 1. La base
# ---------------------------------------------------------------------------
if [ "$SALTAR_BASE" -eq 1 ]; then
  echo "==> Base de datos omitida (--saltar-base)"
else
  args=()
  [ -n "$PROYECTO" ] && args+=("--proyecto=$PROYECTO")
  [ -n "$DB_URL" ] && args+=("--db-url=$DB_URL")
  [ "$SIN_SEMILLA" -eq 1 ] && args+=("--sin-semilla")
  [ -n "$DRY" ] && args+=("$DRY")
  bash "$DIR/conectar-supabase.sh" ${args[@]+"${args[@]}"}
fi

# ---------------------------------------------------------------------------
# 2. La aplicación
# ---------------------------------------------------------------------------
if [ "$SALTAR_VERCEL" -eq 1 ]; then
  echo
  echo "==> Despliegue omitido (--saltar-vercel)"
else
  echo
  args=()
  [ -n "$AMBIENTE" ] && args+=("$AMBIENTE")
  [ -n "$DRY" ] && args+=("$DRY")
  bash "$DIR/subir-vercel.sh" ${args[@]+"${args[@]}"}
fi

echo
verde "Listo."
