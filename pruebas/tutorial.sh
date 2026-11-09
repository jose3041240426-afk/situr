#!/usr/bin/env bash
# ============================================================================
# SITUR — Genera el tutorial con capturas, de principio a fin.
#
#   pruebas/tutorial.sh [base]
#
# Hace las tres cosas, en este orden:
#   1. Comprueba que el stack local está en marcha. Si no lo está, lo levanta.
#   2. Deja la base **limpia**: la recrea con `reiniciar-base.sh`, que NO
#      reinicia el servidor de desarrollo. Reiniciarlo es el mayor pico de
#      memoria de toda la operación, y en una máquina con 8 GB el
#      renderizador de Chromium se queda sin memoria a mitad del recorrido.
#   3. Recorre la aplicación y fotografía cada paso.
#
# La aplicación (`npm run dev`) tiene que estar en marcha en otra terminal.
#
# Al terminar deja el stack en pie, para que se pueda seguir trasteando.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${1:-situr_tutorial}"
PUERTO_PROXY=54321

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }

echo "==> 1/5. El stack local"
if curl -s -o /dev/null "http://127.0.0.1:$PUERTO_PROXY/" 2>/dev/null; then
  verde "   ya está en marcha"
else
  echo "   levantándolo (base '$BASE')"
  setsid bash "$DIR/levantar.sh" "$BASE" >/tmp/opencode/tutorial-stack.log 2>&1 &
  listo=0
  for i in $(seq 1 60); do
    if curl -s -o /dev/null "http://127.0.0.1:$PUERTO_PROXY/" 2>/dev/null; then
      listo=1
      break
    fi
    sleep 1
  done
  if [ "$listo" -ne 1 ]; then
    rojo "   la API no respondió. Mira /tmp/opencode/tutorial-stack.log"
    exit 1
  fi
  verde "   en marcha"
fi

echo "==> 2/5. La base, limpia"
if ! bash "$DIR/reiniciar-base.sh" "$BASE"; then
  rojo "   no se pudo reiniciar la base"
  exit 1
fi

# El recorrido se hace contra el BUILD DE PRODUCCIÓN, servido con
# `vite preview`, y no contra el servidor de desarrollo. La razón es
# práctica: el servidor de desarrollo se reinicia (por el `.env.local` que
# reescribe el arnés), recarga las páginas a mitad de una navegación y
# aborta las navegaciones pendientes. Con el build, la aplicación sirve
# exactamente lo que se despliega, sin sorpresas, y el recorrido va en
# una sola pasada.
echo "==> 3/4. El build y la vista previa"
npm run build >/dev/null 2>&1 || { rojo "   no se pudo compilar"; exit 1; }
PUERTO_PREVIEW=5205
setsid npx vite preview --port "$PUERTO_PREVIEW" --host 127.0.0.1 \
  >/tmp/opencode/tutorial-preview.log 2>&1 &
preview=0
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$PUERTO_PREVIEW/" 2>/dev/null; then
    preview=1
    break
  fi
  sleep 1
done
if [ "$preview" -ne 1 ]; then
  rojo "   la vista previa no arrancó. Mira /tmp/opencode/tutorial-preview.log"
  exit 1
fi
URL_TUTORIAL="http://127.0.0.1:$PUERTO_PREVIEW"
verde "   build servido en $URL_TUTORIAL"

echo "==> 4/4. Recorrido con capturas"
# El recorrido se repite hasta que salga. Con 8 GB de RAM y
# `vm.overcommit_memory` en 0, el renderizador de Chromium se queda sin
# memoria a veces a mitad de la vuelta: no es un fallo del recorrido, es de
# la máquina, y repetirlo lo resuelve. Las capturas se sobrescriben, así que
# gana la vuelta que llega al final.
recorrido=1
VUELTAS=6
while [ "$recorrido" -le "$VUELTAS" ]; do
  echo "    (vuelta $recorrido de $VUELTAS)"
  if node "$DIR/tutorial.mjs" --base="$BASE" --url="$URL_TUTORIAL"; then
    break
  fi
  echo "    la vuelta $recorrido no llegó al final; se repite"
  bash "$DIR/reiniciar-base.sh" "$BASE" >/dev/null 2>&1
  # Se espera a que la maquina espere: el problema no es del recorrido, es
  # que con la memoria justa el renderizador de Chromium se queda sin
  # aire a mitad de la vuelta.
  sleep 12
  recorrido=$((recorrido + 1))
done

if [ "$recorrido" -gt "$VUELTAS" ]; then
  rojo "No se pudo completar el recorrido en $VUELTAS vueltas."
  exit 1
fi

# El PDF va aparte: tiene que embeber 21 imagenes y es lo que se queda sin
# memoria. Separado, un fallo en el PDF no tira las capturas, y se puede
# repetir solo el PDF.
echo "==> 5/5. El PDF"
pdf=1
while [ "$pdf" -le 3 ]; do
  echo "    (vuelta $pdf de 3)"
  if node "$DIR/tutorial-pdf.mjs"; then
    exit 0
  fi
  echo "    la vuelta $pdf no llegó al final; se repite"
  sleep 5
  pdf=$((pdf + 1))
done
rojo "No se pudo generar el PDF en tres vueltas."
exit 1
