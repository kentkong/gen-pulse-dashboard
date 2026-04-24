#!/usr/bin/env bash
# ============================================================================
# tunnel-watchdog.sh
# ----------------------------------------------------------------------------
# Keeps an ephemeral Cloudflare quick-tunnel alive in front of the local
# Gen Pulse dashboard for the duration of the demo. Supervises
# `cloudflared tunnel --url http://localhost:<port>` in a restart loop,
# parses the announced public URL out of its stdout, and persists it to
# data/tunnel-state.json so the dashboard (and demo operator) can always
# find the current share link.
#
# WHY
#   Named tunnels would give us a stable URL, but they require a
#   Cloudflare account + a zone (domain). We don't have one, so we lean
#   on *.trycloudflare.com quick tunnels. The URL changes on every
#   (re)start — which is fine as long as we surface the *current* one
#   reliably. This watchdog is what makes that reliable.
#
# WHAT IT DOES
#   1. Runs cloudflared in the foreground.
#   2. Watches stdout/stderr for the "https://<x>.trycloudflare.com" line.
#   3. Writes it (plus a startedAt timestamp) to data/tunnel-state.json.
#   4. If cloudflared exits (network blip, laptop sleep, rate-limit), it
#      clears data/tunnel-state.json, sleeps with exponential backoff
#      capped at ~60s, and restarts.
#   5. Traps SIGINT / SIGTERM so Ctrl+C kills the child cleanly AND
#      clears the state file (so the UI stops advertising a dead URL).
#
# USAGE
#   ./scripts/tunnel-watchdog.sh               # tunnels http://localhost:3000
#   PORT=4000 ./scripts/tunnel-watchdog.sh     # override the local port
#   CLOUDFLARED=~/bin/cloudflared ./scripts/tunnel-watchdog.sh
#
# STOPPING
#   Ctrl+C. The trap handler will kill the cloudflared child and wipe
#   data/tunnel-state.json on its way out.
# ============================================================================

set -uo pipefail

# --- Config (env-overridable) ------------------------------------------------
PORT="${PORT:-3000}"
LOCAL_URL="${LOCAL_URL:-http://localhost:${PORT}}"
CLOUDFLARED="${CLOUDFLARED:-}"
STATE_FILE="${STATE_FILE:-}"

# Resolve this repo's data/ dir relative to the script, so it works no
# matter where the user cd's into before running it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_DIR/data"
mkdir -p "$DATA_DIR"
: "${STATE_FILE:=$DATA_DIR/tunnel-state.json}"

# Locate cloudflared. Prefer the env override, then ~/bin (user-local
# install, which is what we have here), then whatever's on PATH.
if [[ -z "$CLOUDFLARED" ]]; then
  if [[ -x "$HOME/bin/cloudflared" ]]; then
    CLOUDFLARED="$HOME/bin/cloudflared"
  elif command -v cloudflared >/dev/null 2>&1; then
    CLOUDFLARED="$(command -v cloudflared)"
  else
    echo "[tunnel-watchdog] ERROR: cloudflared not found. Install it or set CLOUDFLARED=/path/to/cloudflared." >&2
    exit 127
  fi
fi

# --- State helpers -----------------------------------------------------------
# Atomic writes only — the dashboard reads this file on every poll, and
# we never want it to observe a half-written JSON document.
write_state() {
  local url="$1"
  local started_at="$2"
  local tmp="${STATE_FILE}.tmp"
  cat > "$tmp" <<EOF
{
  "url": "${url}",
  "localUrl": "${LOCAL_URL}",
  "startedAt": "${started_at}",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "up"
}
EOF
  mv "$tmp" "$STATE_FILE"
}

clear_state() {
  local tmp="${STATE_FILE}.tmp"
  cat > "$tmp" <<EOF
{
  "url": null,
  "localUrl": "${LOCAL_URL}",
  "startedAt": null,
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "down"
}
EOF
  mv "$tmp" "$STATE_FILE"
}

# --- Lifecycle ---------------------------------------------------------------
CHILD_PID=""

cleanup() {
  local code=$?
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "[tunnel-watchdog] stopping cloudflared (pid $CHILD_PID) ..."
    kill "$CHILD_PID" 2>/dev/null || true
    # Give it a couple of seconds to exit gracefully before we nuke it.
    for _ in 1 2 3 4 5; do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.4
    done
    kill -9 "$CHILD_PID" 2>/dev/null || true
  fi
  clear_state
  exit "$code"
}
trap cleanup INT TERM EXIT

# Exponential backoff between restart attempts so we don't hammer
# Cloudflare or flap wildly on a bad network. Resets to 1s once a
# tunnel successfully advertises a URL.
backoff=1
max_backoff=60

echo "[tunnel-watchdog] supervising ${CLOUDFLARED} -> ${LOCAL_URL}"
echo "[tunnel-watchdog] state file: ${STATE_FILE}"

while true; do
  clear_state
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # --metrics 0 disables the local metrics server we don't need,
  # --no-autoupdate stops cloudflared from phoning home mid-demo.
  #
  # We redirect stderr into stdout because cloudflared prints the
  # announced URL on stderr. The `tee` keeps the raw output visible in
  # the user's terminal while our awk sidecar extracts the URL.
  (
    "$CLOUDFLARED" tunnel \
      --url "$LOCAL_URL" \
      --no-autoupdate \
      --metrics 127.0.0.1:0 \
      2>&1
  ) | awk -v state="$STATE_FILE" -v started="$started_at" -v local_url="$LOCAL_URL" '
    {
      print
      fflush()
      # Only match, write, and log the *first* announced URL per
      # tunnel lifecycle. cloudflared sometimes prints the URL twice
      # in the ASCII banner and we do not want two noisy log lines.
      if (!seen && $0 ~ /https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/) {
        # Extract the first match on the line. awk has no builtin regex
        # capture in POSIX mode, so do it the portable way via
        # match() + substr(). Works in BSD awk (macOS default) — we
        # cannot use strftime() here because BSD awk lacks it.
        line = $0
        if (match(line, /https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/)) {
          url = substr(line, RSTART, RLENGTH)
          tmp = state ".tmp"
          # updatedAt == started is fine on the initial capture —
          # the tunnel literally came up moments ago, and the watchdog
          # will overwrite this file on the next restart anyway.
          printf "{\n  \"url\": \"%s\",\n  \"localUrl\": \"%s\",\n  \"startedAt\": \"%s\",\n  \"updatedAt\": \"%s\",\n  \"status\": \"up\"\n}\n", \
            url, local_url, started, started > tmp
          close(tmp)
          # mv via shell — awk has no rename primitive.
          cmd = "mv \"" tmp "\" \"" state "\""
          system(cmd)
          print "[tunnel-watchdog] public URL: " url > "/dev/stderr"
          seen = 1
        }
      }
    }
  ' &
  CHILD_PID=$!

  # Wait for the pipeline. We can't just `wait $!` reliably across
  # shells because of the pipe, so we poll the pipeline head (awk),
  # which stays alive as long as cloudflared does.
  wait "$CHILD_PID" || true
  CHILD_PID=""

  # If we got here, cloudflared died. Reset URL state, back off, retry.
  clear_state
  echo "[tunnel-watchdog] cloudflared exited — restarting in ${backoff}s" >&2
  sleep "$backoff"
  if (( backoff < max_backoff )); then
    backoff=$(( backoff * 2 ))
    if (( backoff > max_backoff )); then
      backoff=$max_backoff
    fi
  fi
done
