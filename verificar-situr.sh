#!/usr/bin/env bash
# ============================================================================
# SITUR — Verificación automática
# ----------------------------------------------------------------------------
# Uso:
#   ./verificar-situr.sh                    # checks de solo lectura
#   ./verificar-situr.sh --e2e              # + flujo E2E (necesita BD limpia)
#   ./verificar-situr.sh --e2e --limpiar    # + limpia BD antes (DESTRUCTIVO)
# ============================================================================
set -u

URL="http://localhost:5173"
PROXY="http://127.0.0.1:54321"
APP="$(cd "$(dirname "$0")" && pwd)"

V=$'\033[32m'; R=$'\033[31m'; A=$'\033[33m'; G=$'\033[90m'; N=$'\033[0m'

E2E=0; LIMPIAR=0
for a in "$@"; do
  [[ "$a" == "--e2e" ]] && E2E=1
  [[ "$a" == "--limpiar" ]] && LIMPIAR=1
done

ok=0; fail=0; manual=0
check()  { if eval "$2" >/dev/null 2>&1; then echo "  ${V}✓${N} $1"; ok=$((ok+1)); else echo "  ${R}✗${N} $1"; fail=$((fail+1)); fi; }
manual() { echo "  ${A}⟳${N} $1 ${G}(a mano)${N}"; manual=$((manual+1)); }
sec()    { echo; echo "▶ $1"; }
psql1()  { sudo -u postgres psql -X -d situr_app -tAc "$1" 2>/dev/null; }
jsonget(){ python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1','') if isinstance(d,dict) else '')" 2>/dev/null; }

# Primero, asegurar sudo cacheado (evita prompts múltiples)
sudo -v 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════"
echo " SITUR — verificación completa"
echo "════════════════════════════════════════════════════════════"
cd "$APP" || exit 1

# ─── 1. Entorno ───
sec "1. Entorno"
check "existe .env.local" "[ -f .env.local ]"
check ".env.local tiene JWT (no REEMPLAZAR)" "grep -qE '^VITE_SUPABASE_ANON_KEY=eyJ' .env.local"
check "dev server responde :5173" "curl -sf -o /dev/null $URL/"
check "arnés responde :54321" "curl -sf -o /dev/null $PROXY/"

# ─── 2. Base de datos ───
sec "2. Base de datos"
check "columna preferencia_aviso_minutos" "[ \"\$(psql1 \"SELECT 1 FROM information_schema.columns WHERE table_name='turnos' AND column_name='preferencia_aviso_minutos'\")\" = '1' ]"
check "columna token_primer_acceso" "[ \"\$(psql1 \"SELECT 1 FROM information_schema.columns WHERE table_name='turnos' AND column_name='token_primer_acceso'\")\" = '1' ]"
check "RPC actualizar_preferencia_aviso existe" "[ \"\$(psql1 \"SELECT 1 FROM pg_proc WHERE proname='actualizar_preferencia_aviso'\")\" = '1' ]"
check "programar_aviso_siguiente tiene guard" "[ \"\$(psql1 \"SELECT 1 FROM pg_proc WHERE proname='programar_aviso_siguiente' AND prosrc LIKE '%aviso_programado_en IS NULL%'\")\" = '1' ]"
check "get_turno_publico devuelve token_primer_acceso" "[ \"\$(psql1 \"SELECT 1 FROM pg_proc WHERE proname='get_turno_publico' AND prosrc LIKE '%token_primer_acceso%'\")\" = '1' ]"
check "anon puede llamar actualizar_preferencia_aviso" "[ \"\$(psql1 \"SELECT has_function_privilege('anon','actualizar_preferencia_aviso(text,integer)','EXECUTE')\")\" = 't' ]"
check "authenticated puede llamar actualizar_preferencia_aviso" "[ \"\$(psql1 \"SELECT has_function_privilege('authenticated','actualizar_preferencia_aviso(text,integer)','EXECUTE')\")\" = 't' ]"

# ─── 3. Endpoints ───
sec "3. Endpoints"
check "/api/turno rechaza token inválido" "curl -s -o /dev/null -w '%{http_code}' \"$URL/api/turno?token=0000000000000000000000000000000000000000000000000000000000000000\" | grep -qE '^(400|404|410)$'"
check "/api/ultimas-llamadas responde 200" "curl -sf -o /dev/null \"$URL/api/ultimas-llamadas?limite=3\""
check "/api/push rechaza sin Authorization" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $URL/api/push)\" = '401' ]"

# ─── 4. E2E ───
if [[ $E2E -eq 1 ]]; then
  sec "4. Flujo end-to-end"

  if [[ $LIMPIAR -eq 1 ]]; then
    echo "  ${A}⚠${N}  Borrando BD en 3s (Ctrl+C para cancelar)..."
    sleep 3
    for t in suscripciones_push historial_turnos auditoria turnos folios periodos_operativos; do
      sudo -u postgres psql -X -d situr_app -c "DELETE FROM $t;" >/dev/null 2>&1
    done
    echo "  ${V}✓${N} BD limpia"
    ok=$((ok+1))
  fi

  WAITING=$(psql1 "SELECT count(*) FROM turnos WHERE estado='WAITING'")
  if [[ "${WAITING:-0}" != "0" ]]; then
    echo "  ${A}⚠${N}  Hay $WAITING turnos en espera. Necesitas --limpiar para un flujo limpio."
    echo "      ./verificar-situr.sh --e2e --limpiar"
    exit 1
  fi

  # Login admin
  LOGIN=$(curl -s -X POST "$URL/api/login" -H "content-type: application/json" -d '{"email":"admin@situr.local","password":"situr-admin-2026"}')
  ACCESS=$(echo "$LOGIN" | jsonget access_token)
  if [[ -z "$ACCESS" ]]; then
    echo "  ${R}✗${N} Login admin falló: ${LOGIN:0:120}"
    fail=$((fail+1))
  else
    echo "  ${V}✓${N} Login admin"; ok=$((ok+1))
    ANON=$(grep '^VITE_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2)

    # Abrir periodo
    HOY=$(date +%Y-%m-%d)
    curl -s -X POST "$PROXY/rest/v1/rpc/abrir_periodo_operativo" \
      -H "apikey: $ANON" -H "Authorization: Bearer $ACCESS" -H "content-type: application/json" \
      -d "{\"p_fecha\":\"$HOY\"}" >/dev/null
    PA=$(psql1 "SELECT count(*) FROM periodos_operativos WHERE estado='ABIERTO'")
    [[ "$PA" == "1" ]] && { echo "  ${V}✓${N} Periodo abierto"; ok=$((ok+1)); } || { echo "  ${R}✗${N} Periodo no abierto ($PA)"; fail=$((fail+1)); }

    # Emitir 3 turnos
    TRAMITE=$(psql1 "SELECT id FROM tramites WHERE clave='PRED' LIMIT 1")
    T1=""; T2=""; T3=""
    for i in 1 2 3; do
      R=$(curl -s -X POST "$PROXY/rest/v1/rpc/generar_turno" 2>/dev/null \
        -H "apikey: $ANON" -H "Authorization: Bearer $ACCESS" -H "content-type: application/json" \
        -d "{\"p_tramite_id\":\"$TRAMITE\",\"p_prioridad\":null}")
      TK=$(echo "$R" | jsonget token_publico)
      [[ $i -eq 1 ]] && T1="$TK"
      [[ $i -eq 2 ]] && T2="$TK"
      [[ $i -eq 3 ]] && T3="$TK"
    done
    if [[ -n "$T1" && -n "$T2" && -n "$T3" ]]; then
      echo "  ${V}✓${N} 3 turnos emitidos"; ok=$((ok+1))
    else
      echo "  ${R}✗${N} Emisión falló"; fail=$((fail+1)); exit 1
    fi

    # 1ª consulta pública
    C1=$(curl -s "$URL/api/turno?token=$T1")
    if echo "$C1" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
      echo "  ${V}✓${N} /api/turno devuelve el turno"; ok=$((ok+1))
      echo "$C1" | grep -q '"token_primer_acceso":null' \
        && { echo "  ${V}✓${N} token_primer_acceso null en 1ª consulta"; ok=$((ok+1)); } \
        || { echo "  ${R}✗${N} token_primer_acceso no era null"; fail=$((fail+1)); }
      echo "$C1" | grep -q '"preferencia_aviso_minutos":null' \
        && { echo "  ${V}✓${N} preferencia null inicial"; ok=$((ok+1)); } \
        || { echo "  ${R}✗${N} preferencia no era null"; fail=$((fail+1)); }
    else
      echo "  ${R}✗${N} /api/turno falló: ${C1:0:120}"; fail=$((fail+1))
    fi

    # Preferencia = 15
    P=$(curl -s -X POST "$PROXY/rest/v1/rpc/actualizar_preferencia_aviso" \
      -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "content-type: application/json" \
      -d "{\"p_token\":\"$T1\",\"p_minutos\":15}")
    if echo "$P" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
      echo "  ${V}✓${N} RPC actualizar_preferencia_aviso OK"; ok=$((ok+1))
      PB=$(psql1 "SELECT preferencia_aviso_minutos FROM turnos WHERE token_publico='$T1'")
      [[ "$PB" == "15" ]] && { echo "  ${V}✓${N} preferencia persiste en BD"; ok=$((ok+1)); } || { echo "  ${R}✗${N} preferencia en BD=$PB"; fail=$((fail+1)); }
    else
      echo "  ${R}✗${N} RPC preferencia falló: ${P:0:120}"; fail=$((fail+1))
    fi

    # 2ª consulta → token_primer_acceso seteado
    sleep 1
    C2=$(curl -s "$URL/api/turno?token=$T1")
    TP=$(echo "$C2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token_primer_acceso') or '')" 2>/dev/null)
    [[ -n "$TP" ]] && { echo "  ${V}✓${N} token_primer_acceso seteado tras 1ª consulta"; ok=$((ok+1)); } || { echo "  ${R}✗${N} token_primer_acceso no se seteó"; fail=$((fail+1)); }

    # Aviso no se pisa
    psql1 "UPDATE turnos SET estado='SERVING', inicio_atencion=now() WHERE token_publico='$T1'" >/dev/null

    curl -s -X POST "$PROXY/rest/v1/rpc/programar_aviso_siguiente" \
      -H "apikey: $ANON" -H "Authorization: Bearer $ACCESS" -H "content-type: application/json" \
      -d '{"p_minutos":15,"p_tramite_id":null}' >/dev/null
    A2=$(psql1 "SELECT aviso_programado_en FROM turnos WHERE token_publico='$T2'")
    [[ -n "$A2" ]] && { echo "  ${V}✓${N} turno 2 tiene aviso +15"; ok=$((ok+1)); } || { echo "  ${R}✗${N} turno 2 sin aviso"; fail=$((fail+1)); }

    sleep 1
    curl -s -X POST "$PROXY/rest/v1/rpc/programar_aviso_siguiente" \
      -H "apikey: $ANON" -H "Authorization: Bearer $ACCESS" -H "content-type: application/json" \
      -d '{"p_minutos":5,"p_tramite_id":null}' >/dev/null
    A2b=$(psql1 "SELECT aviso_programado_en FROM turnos WHERE token_publico='$T2'")
    A3=$(psql1 "SELECT aviso_programado_en FROM turnos WHERE token_publico='$T3'")
    if [[ "$A2" == "$A2b" && -n "$A3" ]]; then
      echo "  ${V}✓${N} aviso del turno 2 NO se pisó, turno 3 recibió el suyo"; ok=$((ok+1))
    else
      echo "  ${R}✗${N} aviso se pisó o turno 3 sin aviso (t2=$A2→$A2b t3=$A3)"; fail=$((fail+1))
    fi
  fi
fi

# ─── 5. Manual ───
sec "5. Verificación manual (requiere navegador)"
manual "Abrir /turno/<token> en incógnito → modal a los 0.8s"
manual "Pulsar 'Sí, avísame' → permiso del navegador → paso 2"
manual "Elegir 'Con tiempo' → cierra, no reabre en 30s"
manual "F5 → sin 'Primera vez', sin modal, con 'Cambiar preferencia'"
manual "Acordeones (3): deslizamiento + chevron rota"
manual "Responsive 320/375/768: sin scroll horizontal"
manual "Riel azul sin módulo ni tiempo estimado"

# ─── Reporte ───
echo
echo "════════════════════════════════════════════════════════════"
echo " Resultado: ${V}$ok OK${N}, ${R}$fail fallos${N}, ${A}$manual manuales${N}"
echo "════════════════════════════════════════════════════════════"
exit $fail
