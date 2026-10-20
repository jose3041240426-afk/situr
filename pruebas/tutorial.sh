#!/usr/bin/env bash
# ============================================================================
# SITUR — Genera el tutorial con capturas, de principio a fin.
#
#   pruebas/tutorial.sh [base]
#
# Hace las tres cosas, en este orden:
#   1. Levanta el stack local contra una base RECIÉN MIGRADA Y VACÍA.
#      Necesita estar vacía porque el recorrido tiene que empezar de cero:
#      si ya hay un periodo abierto o turnos emitidos, faltan pasos (el MFA
#      no se pide dos veces, el periodo no se abre dos veces) y las
#      capturas no cuentan lo que dicen que cuentan. Y el MFA vive en
#      memoria del arnés, así que reiniciarlo es lo único que lo vuelve a
#      pedir.
#   2. Espera a que la API responda.
#   3. Recorre la aplicación y fotografía cada paso.
#
# La aplicación (`npm run dev`) tiene que estar en marcha en otra terminal.
#
# Al terminar deja el stack en pie, para que se pueda seguir trasteando.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${1:-situr_tutorial}"
PUERTO_PROXY=54321

verde() { printf '\033[32m%s\033[0m\n' "$1"; }

echo "==> 1/3. Stack local contra la base limpia '$BASE'"
# `levantar.sh` se queda en marcha, así que va en segundo plano.
setsid bash "$DIR/levantar.sh" "$BASE" >/tmp/opencode/tutorial-stack.log 2>&1 &

echo "==> 2/3. Esperando a que la API responda"
listo=0
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PUERTO_PROXY/" 2>/dev/null; then
    listo=1
    break
  fi
  sleep 1
done
if [ "$listo" -ne 1 ]; then
  echo "La API no respondió. Mira /tmp/opencode/tutorial-stack.log" >&2
  exit 1
fi

# `levantar.sh` reescribe `.env.local`, y eso hace que Vite se reinicie
# solo. Se le da un respiro para que se estabilice antes de empezar, o la
# primera carga cae en mitad del reinicio.
echo "==> 3/3. Recorrido con capturas"
sleep 3
node "$DIR/tutorial.mjs" --base="$BASE"
