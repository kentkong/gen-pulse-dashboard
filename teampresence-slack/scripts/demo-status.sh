#!/usr/bin/env bash
# ============================================================================
# demo-status.sh
# ----------------------------------------------------------------------------
# One-shot health probe for the live demo stack. Designed to be run
# 60 seconds before a customer call (and any time you suspect drift):
#
#   ./scripts/demo-status.sh
#
# Reports green/red on every link in the chain:
#   1. Local Node server bound on :PORT
#   2. Cloudflare tunnel watchdog process alive
#   3. data/tunnel-state.json says status=up with a fresh URL
#   4. Public URL answers /healthz, /img/up-badge-mono.png and the
#      authenticated dashboard
#   5. Each Jira/presence integration loaded cleanly (parsed from
#      data/logs/server.log)
#
# It does NOT mutate anything. Safe to run during the demo if Alan
# asks "is everything fine?" mid-call.
#
# Exit codes:
#   0 = all green
#   1 = at least one critical check failed (printed in red above)
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

PORT="${PORT:-3000}"
STATE_FILE="$REPO_DIR/data/tunnel-state.json"

# The server log lives in one of two places depending on how it was
# launched: data/logs/server.log (via demo-start.sh) or
# /tmp/gen-pulse/server.log (via ad-hoc nohup). Pick whichever was
# written most recently — picking the wrong one silently misreports
# integrations as down because the patterns don't match in stale logs.
candidate_a="$REPO_DIR/data/logs/server.log"
candidate_b="/tmp/gen-pulse/server.log"
SERVER_LOG=""
if [[ -f "$candidate_a" && -f "$candidate_b" ]]; then
  if [[ "$candidate_a" -nt "$candidate_b" ]]; then SERVER_LOG="$candidate_a"; else SERVER_LOG="$candidate_b"; fi
elif [[ -f "$candidate_a" ]]; then SERVER_LOG="$candidate_a"
elif [[ -f "$candidate_b" ]]; then SERVER_LOG="$candidate_b"
fi

# Corporate CA bundle is required for cloudflared HTTPS through MITM
# inspection. Absent on personal machines — fall back to system bundle.
CACERT="${CACERT:-/Users/kevin.mold/.certs/corporate-bundle.pem}"
CURL_OPTS=(--silent --show-error --max-time 10)
[ -f "$CACERT" ] && CURL_OPTS+=(--cacert "$CACERT")

# --- Pretty printing -------------------------------------------------------
# bash double-quoted strings do NOT interpret \033, so we use the
# ANSI-C $'...' form to get a real ESC character in the variable.
# Without this, the colour codes print as literal "\033[1;32m" text.
GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; YELLOW=$'\033[1;33m'
DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
PASS=0; FAIL=0

check() {
  local label="$1"; local result="$2"; local detail="${3:-}"
  if [[ "$result" == "ok" ]]; then
    printf "  ${GREEN}✓${RESET}  %-40s %s\n" "$label" "${DIM}${detail}${RESET}"
    PASS=$((PASS + 1))
  elif [[ "$result" == "warn" ]]; then
    printf "  ${YELLOW}!${RESET}  %-40s %s\n" "$label" "$detail"
  else
    printf "  ${RED}✗${RESET}  %-40s %s\n" "$label" "$detail"
    FAIL=$((FAIL + 1))
  fi
}

printf "${BOLD}Gen Pulse — demo readiness probe${RESET}\n"
printf "${DIM}port=%s · state=%s${RESET}\n\n" "$PORT" "$STATE_FILE"

# --- 1. Local server ------------------------------------------------------
printf "${BOLD}1. Local server${RESET}\n"
if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  pid=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  check "node listening on :$PORT" ok "pid $pid"
else
  check "node listening on :$PORT" fail "no process — start with ./scripts/demo-start.sh"
fi

if curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "http://localhost:$PORT/healthz" 2>/dev/null | grep -q "^200$"; then
  check "GET localhost/healthz" ok "200"
else
  check "GET localhost/healthz" fail "non-200 response"
fi

# --- 2. Tunnel watchdog ---------------------------------------------------
printf "\n${BOLD}2. Cloudflare tunnel${RESET}\n"
# `ps -ax -o pid,command` truncates args on macOS which made our
# pattern miss long command lines. `ps -axww -o pid,args` keeps the
# full command line, so the watchdog grep is reliable.
watchdog_pid=$(ps -axww -o pid,args 2>/dev/null | awk '/tunnel-watchdog\.sh/ && !/awk/ {print $1; exit}')
if [[ -n "$watchdog_pid" ]]; then
  check "tunnel-watchdog.sh supervising" ok "pid $watchdog_pid"
else
  check "tunnel-watchdog.sh supervising" fail "not running — start ./scripts/tunnel-watchdog.sh"
fi

cf_pid=$(ps -axww -o pid,args 2>/dev/null | awk '/cloudflared.*--url/ && !/awk/ {print $1; exit}')
if [[ -n "$cf_pid" ]]; then
  check "cloudflared child process" ok "pid $cf_pid"
else
  check "cloudflared child process" fail "no cloudflared — watchdog should respawn"
fi

# caffeinate is what stops the Mac sleeping mid-demo (or overnight if
# we set up the day before). It's not strictly *required* for the
# demo to work — if the laptop is awake, sleep can't hit anyway — but
# it's the single biggest "left it on overnight and the URL rotated"
# foot-gun, so we surface it loudly.
caf_pid=$(ps -axww -o pid,args 2>/dev/null | awk '/caffeinate.*-w/ && !/awk/ {print $1; exit}')
if [[ -n "$caf_pid" ]]; then
  caf_target=$(ps -axww -o pid,args 2>/dev/null | awk -v p="$caf_pid" '$1==p {for (i=2;i<=NF;i++) if ($i=="-w") {print $(i+1); exit}}')
  if [[ -n "${pid:-}" && "$caf_target" == "$pid" ]]; then
    check "caffeinate guarding node pid"   ok "pid $caf_pid (-w $caf_target)"
  else
    check "caffeinate guarding node pid"   warn "running (pid $caf_pid) but watching pid $caf_target — node is $pid"
  fi
else
  check "caffeinate guarding node pid"     warn "not running — Mac may sleep. Start: nohup caffeinate -dimsu -w \$(lsof -tiTCP:$PORT -sTCP:LISTEN | head -1) >/dev/null 2>&1 & disown"
fi

# --- 3. State file --------------------------------------------------------
if [[ -s "$STATE_FILE" ]]; then
  status=$(awk -F'"' '/"status"[[:space:]]*:/ {print $4; exit}' "$STATE_FILE")
  url=$(awk -F'"' '/"url"[[:space:]]*:[[:space:]]*"http/ {print $4; exit}' "$STATE_FILE")
  updated=$(awk -F'"' '/"updatedAt"[[:space:]]*:/ {print $4; exit}' "$STATE_FILE")
  if [[ "$status" == "up" && -n "$url" ]]; then
    check "tunnel-state.json status=up"  ok "since $updated"
  else
    check "tunnel-state.json status=up"  fail "status=$status url=$url"
  fi
else
  url=""
  check "tunnel-state.json present" fail "no file at $STATE_FILE"
fi

# --- 4. Public reachability ----------------------------------------------
if [[ -n "$url" ]]; then
  printf "\n${BOLD}3. Public reachability${RESET}  ${DIM}(%s)${RESET}\n" "$url"
  # /healthz: cheap, anonymous, must be 200
  rc=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "$url/healthz" 2>/dev/null)
  if [[ "$rc" == "200" ]]; then check "GET /healthz" ok "200"; else check "GET /healthz" fail "HTTP $rc"; fi
  # /img/up-badge-mono.png: confirms /img/ route is live
  rc=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "$url/img/up-badge-mono.png" 2>/dev/null)
  if [[ "$rc" == "200" ]]; then check "GET /img/up-badge-mono.png" ok "200"; else check "GET /img/up-badge-mono.png" fail "HTTP $rc"; fi
  # Authenticated dashboard root
  KEY=$(awk -F= '/^DASHBOARD_KEY=/{v=$2; gsub(/"/,"",v); print v}' .env 2>/dev/null)
  if [[ -n "$KEY" ]]; then
    rc=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "$url/?key=$KEY" 2>/dev/null)
    if [[ "$rc" == "200" ]]; then check "GET /?key=… (dashboard)" ok "200"; else check "GET /?key=… (dashboard)" fail "HTTP $rc"; fi
  else
    check "GET /?key=… (dashboard)" warn "no DASHBOARD_KEY in .env"
  fi
fi

# --- 5. Integration boot lines -------------------------------------------
if [[ -f "$SERVER_LOG" ]]; then
  printf "\n${BOLD}4. Integrations${RESET}  ${DIM}(grepped from %s)${RESET}\n" "${SERVER_LOG/$REPO_DIR\//}"
  # Each pattern is a single canonical line that proves the integration
  # finished its boot handshake. Missing line = failure mode.
  declare -a checks=(
    "Slack roster overrides|slack overrides: applied"
    "Presence model running|\\[presence\\] model="
    "Workday provider loaded|Workday provider:"
    "Jira multi-project|jira\\] multi-project:"
    "Auth strategy chosen|auth\\] (continuing|OIDC activated|switched to)"
    "Weather provider|weather\\] enabled|weather\\] disabled"
  )
  for entry in "${checks[@]}"; do
    label="${entry%%|*}"; pattern="${entry#*|}"
    line=$(grep -E "$pattern" "$SERVER_LOG" 2>/dev/null | tail -1)
    if [[ -n "$line" ]]; then
      detail=$(printf "%s" "$line" | tr -d '\r' | head -c 90)
      check "$label" ok "$detail"
    else
      check "$label" warn "no boot line matched"
    fi
  done
fi

# --- Summary ---------------------------------------------------------------
printf "\n"
if (( FAIL == 0 )); then
  printf "${GREEN}${BOLD}All %d critical checks passed.${RESET}\n" "$PASS"
  if [[ -n "${url:-}" && -n "${KEY:-}" ]]; then
    printf "\n${BOLD}Demo URL (desktop + mobile, same link):${RESET}\n  %s/?key=%s\n" "$url" "$KEY"
  fi
  exit 0
else
  printf "${RED}${BOLD}%d check(s) failed${RESET} — see lines marked ${RED}✗${RESET} above.\n" "$FAIL"
  exit 1
fi
