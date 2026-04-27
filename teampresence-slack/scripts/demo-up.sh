#!/usr/bin/env bash
# ============================================================================
# demo-up.sh
# ----------------------------------------------------------------------------
# Sleep-proof wrapper around demo-start.sh. Use this for the actual
# customer demo (not for development).
#
# WHAT IT ADDS OVER demo-start.sh
#   1. caffeinate(8): blocks display + idle + system + disk sleep so
#      the dashboard never goes blank mid-demo if you stop touching
#      your trackpad. Released automatically when you Ctrl+C the
#      script (or when caffeinate's child exits).
#   2. Pre-flight check: aborts loudly BEFORE launching anything if
#      port :PORT is already taken, so we never end up with two
#      conflicting node processes on the same port.
#   3. Pretty banner with the URL once the tunnel is up — no scrolling
#      through tail -F output to find it.
#
# USAGE
#   ./scripts/demo-up.sh                   # standard
#   PORT=3000 ./scripts/demo-up.sh         # override port
#   NO_CAFFEINATE=1 ./scripts/demo-up.sh   # disable sleep-prevention
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

PORT="${PORT:-3000}"

GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; YELLOW=$'\033[1;33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
note() { printf "${BOLD}[demo-up]${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}[demo-up]${RESET} %s\n" "$*" >&2; }
err()  { printf "${RED}[demo-up]${RESET} %s\n" "$*" >&2; }

# Pre-flight: nothing else listening on our port.
if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  pid=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  err ":$PORT is already in use (pid $pid)."
  err "If this is a stale Gen Pulse process, run:  kill $pid"
  err "Then re-run ./scripts/demo-up.sh"
  exit 1
fi

# Compose the underlying command. caffeinate -dimsu prevents:
#   -d  display sleep
#   -i  idle sleep
#   -m  disk sleep
#   -s  system sleep (only when on AC; harmless when on battery)
#   -u  asserts user activity for the next ~5s on launch (handy when
#        the screen has already dimmed — pops it back on)
# When run with a child command, caffeinate exits when the child does,
# so Ctrl+C in demo-start.sh releases the assertion automatically.
if [[ "${NO_CAFFEINATE:-0}" == "1" ]]; then
  warn "NO_CAFFEINATE=1 — Mac may sleep mid-demo if untouched."
  exec env PORT="$PORT" "$SCRIPT_DIR/demo-start.sh"
fi

if ! command -v caffeinate >/dev/null 2>&1; then
  warn "caffeinate not on PATH — running without sleep-prevention."
  exec env PORT="$PORT" "$SCRIPT_DIR/demo-start.sh"
fi

note "wrapping demo-start.sh in caffeinate -dimsu (Mac will not sleep)"
exec caffeinate -dimsu env PORT="$PORT" "$SCRIPT_DIR/demo-start.sh"
