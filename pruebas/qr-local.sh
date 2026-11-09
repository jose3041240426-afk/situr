#!/usr/bin/env bash
# ============================================================================
# SITUR — Abrir la aplicación desde el celular y escanear el QR del turno.
#
#   pruebas/qr-local.sh [puerto-de-la-app]
#
# Por qué existe: el QR del turno se genera con `window.location.origin`. Si
# la consola se abre en `http://localhost:5173`, el QR guarda `localhost`, y
# al escanearlo el teléfono busca el servidor **en sí mismo** y no encuentra
# nada. Abriendo la consola en `http://<ip-de-la-pc>:5173`, el QR guarda esa
# dirección y el teléfono sí llega.
#
# Este script imprime la dirección correcta y su QR, y comprueba que la
# aplicación y la API responden en la red local.
# ============================================================================
set -euo pipefail

PUERTO_APP="${1:-5173}"
PUERTO_API="${PUERTO_API:-54321}"

rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }
gris()  { printf '\033[90m%s\033[0m\n' "$1"; }

IP="${SITUR_ANFITRION:-}"
if [ -z "$IP" ]; then
  IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
fi
if [ -z "$IP" ]; then
  rojo "No se pudo averiguar la IP de esta computadora."
  rojo "Pásala a mano:  SITUR_ANFITRION=192.168.1.50 $0"
  exit 1
fi

URL_APP="http://$IP:$PUERTO_APP"
URL_API="http://$IP:$PUERTO_API"

echo
echo "  Dirección para el celular:  $URL_APP"
echo "  API local:                  $URL_API"
echo

# --- ¿Está todo en pie en esa dirección? ------------------------------------
fallos=0
if curl -sf -o /dev/null --max-time 3 "$URL_APP" 2>/dev/null; then
  verde "  ✓ la aplicación responde en $URL_APP"
else
  rojo  "  ✗ la aplicación NO responde en $URL_APP"
  gris  "    arranca el servidor de desarrollo:  cd app && npm run dev"
  gris  "    (vite.config.ts ya escucha en toda la red: host: true)"
  fallos=1
fi

if curl -sf -o /dev/null --max-time 3 "$URL_API/" 2>/dev/null; then
  verde "  ✓ la API responde en $URL_API"
else
  rojo  "  ✗ la API NO responde en $URL_API"
  gris  "    arranca el arnés con la IP de la PC, no con 127.0.0.1:"
  gris  "      SITUR_ANFITRION=$IP pruebas/levantar.sh"
  fallos=1
fi

echo
if [ "$fallos" -eq 0 ]; then
  echo "  Escanea este QR con el celular (misma red Wi-Fi):"
  echo
  if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 -m 1 "$URL_APP" | sed 's/^/  /'
  else
    gris "  (no está `qrencode`: escribe la dirección a mano)"
  fi
  echo
  echo "  Abre la consola en esa misma dirección, NO en localhost:"
  echo "    $URL_APP/admin"
  echo "  El QR que imprimas para un turno apuntará a $URL_APP/turno/<token>"
  echo "  y el teléfono lo abrirá."
else
  echo "  Arregla lo de arriba y vuelve a correr este script."
fi

echo
gris "  Aviso: por http:// el portal funciona, pero el aviso push NO."
gris "  El navegador exige HTTPS (o localhost) para notificaciones y service"
gris "  worker. Para probar el push en el celular hace falta un túnel HTTPS"
gris "  o el despliegue en Vercel."
echo
