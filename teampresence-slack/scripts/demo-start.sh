#!/usr/bin/env bash
# ============================================================================
# demo-start.sh
# ----------------------------------------------------------------------------
# One-command demo bootstrap for Gen Pulse:
#   1. Starts the Node dashboard server (src/index.js) in the background.
#   2. Starts the Cloudflare tunnel watchdog (scripts/tunnel-watchdog.sh)
#      in the background.
#   3. Polls data/tunnel-state.json until the tunnel announces a URL.
#   4. Prints the public URL + the read-only team URL (with the shared
#      dashboard key, if configured) so you can copy/paste straight
#      into Slack.
#   5. Streams both log files to the foreground. Ctrl+C tears down
#      both children in the right order and wipes the tunnel state
#      file so the UI doesn't advertise a dead URL.
#
# USAGE
#   ./scripts/demo-start.sh
#
# ENV OVERRIDES
#   PORT=3000                       # local port the server listens on
#   DASHBOARD_KEY=...               # if set, read-only URL is printed
#   AUTH_STRATEGY=mock-oidc         # recommended for demos
#   LOG_DIR=./data/logs             # where to write server + tunnel logs
#
# LOG LOCATIONS (inside the repo, so they land in data/ which is gitignored)
#   data/logs/server.log
#   data/logs/tunnel.log
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

PORT="${PORT:-3000}"
LOG_DIR="${LOG_DIR:-$REPO_DIR/data/logs}"
STATE_FILE="$REPO_DIR/data/tunnel-state.json"

mkdir -p "$LOG_DIR"

SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

SERVER_PID=""
TUNNEL_PID=""

# Pretty printing — we don't pull in a logger lib, so two helpers keep
# the demo output readable at a glance.
note()  { printf "\033[1;34m[demo]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[demo]\033[0m %s\n" "$*" >&2; }
ok()    { printf "\033[1;32m[demo]\033[0m %s\n" "$*"; }

cleanup() {
  local code=$?
  note "shutting down..."
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # Also wipe the state file so the UI doesn't show a dead URL next
  # time the server starts without the watchdog.
  rm -f "$STATE_FILE"
  exit "$code"
}
trap cleanup INT TERM EXIT

# --- 1. Server --------------------------------------------------------------
note "starting dashboard (PORT=$PORT) -> $SERVER_LOG"
# shellcheck disable=SC2086
PORT="$PORT" node src/index.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
note "server pid: $SERVER_PID"

# Give the server a couple of seconds to bind, with a short healthz
# poll. If it fails to come up, bail out with a clear message instead
# of launching a tunnel to nowhere.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    ok "server is up (healthz ok after ${i}s)"
    break
  fi
  sleep 1
  if (( i == 10 )); then
    warn "server did not respond on http://localhost:$PORT/healthz after 10s"
    warn "last 40 lines of $SERVER_LOG:"
    tail -n 40 "$SERVER_LOG" >&2 || true
    exit 1
  fi
done

# --- 2. Tunnel watchdog -----------------------------------------------------
note "starting Cloudflare tunnel watchdog -> $TUNNEL_LOG"
PORT="$PORT" "$SCRIPT_DIR/tunnel-watchdog.sh" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
note "tunnel pid: $TUNNEL_PID"

# --- 3. Wait for public URL ------------------------------------------------
note "waiting for Cloudflare to announce a public URL..."
PUBLIC_URL=""
for i in $(seq 1 60); do
  if [[ -s "$STATE_FILE" ]]; then
    # Extract the url field without requiring jq on the host.
    PUBLIC_URL=$(awk -F'"' '/"url"[[:space:]]*:[[:space:]]*"http/{print $4; exit}' "$STATE_FILE" || true)
    if [[ -n "$PUBLIC_URL" ]]; then break; fi
  fi
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  warn "no tunnel URL after 60s — check $TUNNEL_LOG"
  warn "the server is still running locally at http://localhost:$PORT"
else
  ok "public URL:        $PUBLIC_URL"
  if [[ -n "${DASHBOARD_KEY:-}" ]]; then
    # Shell-safe URL-encoding is painful for arbitrary keys, so rely on
    # the key already being URL-safe (our DASHBOARD_KEY generator emits
    # hex). If you change that assumption, update this too.
    READ_ONLY_URL="${PUBLIC_URL}/?key=${DASHBOARD_KEY}"
    ok "team read-only:   $READ_ONLY_URL"
  else
    warn "DASHBOARD_KEY not set — team read-only URL not printed."
    warn "Set DASHBOARD_KEY in .env to enable the one-click share link."
  fi
  ok "local dashboard:  http://localhost:$PORT"
fi

# --- 4. Stream logs --------------------------------------------------------
note "streaming logs — Ctrl+C to stop everything"
printf "\n\n"
tail -n 0 -F "$SERVER_LOG" "$TUNNEL_LOG"
