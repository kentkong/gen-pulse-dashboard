#!/usr/bin/env bash
# ============================================================================
# demo-share.sh
# ----------------------------------------------------------------------------
# One-command "send the dashboard to whoever is joining the call."
#
# Reads the *current* tunnel URL from data/tunnel-state.json (written
# by scripts/tunnel-watchdog.sh). Then produces three artefacts:
#
#   1. A paste-ready Slack/email message printed to stdout, including
#      the URL with the dashboard key already appended. The wording
#      is friendly + matches how you'd hand a link to an exec.
#   2. A QR-code PNG saved to data/qr/dashboard-<short>.png so they
#      can scan from a laptop straight onto a phone. (Service:
#      api.qrserver.com — public, no auth, free.)
#   3. A terminal-friendly ASCII QR printed in-place via qrenco.de,
#      so you can hold up your laptop screen and have someone scan
#      without ever opening the PNG.
#
# Both QR services are hit ONCE at script-run time; the resulting
# artefacts are static files, so the demo itself doesn't depend on
# either service. The PNG is yours to drop into Slack, email, or
# AirDrop to your phone for a quick mobile sanity-check.
#
# USAGE
#   ./scripts/demo-share.sh                  # plain output
#   ./scripts/demo-share.sh --no-qr          # skip both QR steps
#   ./scripts/demo-share.sh --slack-only     # just print the message
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Args
SKIP_QR=0
SLACK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-qr)      SKIP_QR=1 ;;
    --slack-only) SLACK_ONLY=1; SKIP_QR=1 ;;
    -h|--help)
      sed -n '/^# =\{60,\}$/,/^# =\{60,\}$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

# Pretty colours — ANSI-C $'\033' so the ESC byte ends up in the var.
GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; YELLOW=$'\033[1;33m'
DIM=$'\033[2m'; BOLD=$'\033[1m'; CYAN=$'\033[1;36m'; RESET=$'\033[0m'

# Corporate cert bundle for HTTPS through MITM inspection. Falls back
# to system bundle on personal machines.
CACERT="${CACERT:-/Users/kevin.mold/.certs/corporate-bundle.pem}"
CURL_OPTS=(--silent --show-error --max-time 10)
[ -f "$CACERT" ] && CURL_OPTS+=(--cacert "$CACERT")

# --- 1. Resolve the current public URL --------------------------------------
STATE_FILE="$REPO_DIR/data/tunnel-state.json"
if [[ ! -s "$STATE_FILE" ]]; then
  printf "${RED}[demo-share]${RESET} no tunnel state at %s\n" "$STATE_FILE" >&2
  printf "${YELLOW}Hint:${RESET} start the supervised tunnel first:\n  ./scripts/demo-up.sh   ${DIM}(or ./scripts/tunnel-watchdog.sh in a spare terminal)${RESET}\n" >&2
  exit 1
fi

URL=$(awk -F'"' '/"url"[[:space:]]*:[[:space:]]*"http/ {print $4; exit}' "$STATE_FILE")
STATUS=$(awk -F'"' '/"status"[[:space:]]*:/ {print $4; exit}' "$STATE_FILE")
if [[ -z "$URL" || "$STATUS" != "up" ]]; then
  printf "${RED}[demo-share]${RESET} tunnel reports status=%s url=%s — not advertising a dead URL.\n" "$STATUS" "$URL" >&2
  printf "${YELLOW}Hint:${RESET} ./scripts/demo-status.sh will tell you what's wrong.\n" >&2
  exit 1
fi

KEY=$(awk -F= '/^DASHBOARD_KEY=/{v=$2; gsub(/"/,"",v); print v}' .env 2>/dev/null)
if [[ -z "$KEY" ]]; then
  printf "${RED}[demo-share]${RESET} DASHBOARD_KEY not in .env — cannot build a read-only URL.\n" >&2
  exit 1
fi

SHARE_URL="${URL}/?key=${KEY}"
BRAND=$(awk -F= '/^BRAND_NAME=/{v=$2; gsub(/"/,"",v); print v}' .env 2>/dev/null)
BRAND="${BRAND:-Gen Pulse}"

# Live reachability probe — refusing to share a URL that doesn't
# answer is much friendlier than letting Alan paste a 502 into his
# browser. We probe /healthz so we don't burn a Jira API call.
HC=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "${URL}/healthz" 2>/dev/null)
if [[ "$HC" != "200" ]]; then
  printf "${YELLOW}[demo-share]${RESET} warn: GET %s/healthz returned HTTP %s — sharing anyway, but verify before pasting.\n" "$URL" "$HC" >&2
fi

# --- 2. Slack-friendly message ---------------------------------------------
# Short hash for filenames + Slack thread reference (8 hex chars from
# the URL itself). Lets you tell two demos apart in `data/qr/` if you
# end up running multiple in one day.
SHORT=$(printf "%s" "$URL" | shasum -a 256 | cut -c1-8)

# Use a here-doc with the *terminating* word quoted so $URL etc. still
# expand. Result is ready to copy-paste into Slack as-is.
SLACK_BODY=$(cat <<EOF
Hi Alan — here's the live ${BRAND} dashboard for our session:
:point_right: ${SHARE_URL}

Works on desktop and mobile (responsive, same link).
Ping me if you hit a blank page and I'll bounce the link.
EOF
)

# --- 3. Output --------------------------------------------------------------
printf "${BOLD}${BRAND} — share kit${RESET}  ${DIM}(generated $(date -u +%Y-%m-%dT%H:%M:%SZ))${RESET}\n"
printf "${DIM}tunnel up since: $(awk -F'"' '/"startedAt"/ {print $4; exit}' "$STATE_FILE")${RESET}\n\n"

printf "${BOLD}Public URL${RESET}\n  ${CYAN}%s${RESET}\n\n" "$SHARE_URL"

printf "${BOLD}Slack/email message${RESET}  ${DIM}(copy from the next %d lines)${RESET}\n" "$(printf "%s" "$SLACK_BODY" | wc -l | tr -d ' ')"
printf "${DIM}-----8<-----${RESET}\n%s\n${DIM}----->8-----${RESET}\n\n" "$SLACK_BODY"

if (( SLACK_ONLY )); then exit 0; fi

if (( SKIP_QR == 0 )); then
  # --- 3a. PNG QR code ----------------------------------------------------
  QR_DIR="$REPO_DIR/data/qr"
  mkdir -p "$QR_DIR"
  QR_PNG="$QR_DIR/dashboard-${SHORT}.png"
  # url-encode the share URL so the QR service treats it as one arg.
  ENCODED=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SHARE_URL")
  HC=$(curl "${CURL_OPTS[@]}" -o "$QR_PNG" -w "%{http_code}" \
    "https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=2&data=${ENCODED}" 2>/dev/null)
  if [[ "$HC" == "200" && -s "$QR_PNG" ]]; then
    printf "${BOLD}QR code (PNG)${RESET}  ${DIM}600×600 · scan to open on phone${RESET}\n  ${GREEN}saved:${RESET} %s\n" "${QR_PNG/$REPO_DIR\//}"
    # macOS-only convenience: open the PNG in Preview if a TTY is attached.
    # Suppressed when piped (e.g. CI) so it doesn't spawn windows
    # in the background.
    if [[ -t 1 ]] && command -v open >/dev/null 2>&1; then
      open "$QR_PNG" >/dev/null 2>&1 || true
      printf "  ${DIM}(opened in Preview)${RESET}\n"
    fi
  else
    printf "${YELLOW}[demo-share]${RESET} QR PNG service returned HTTP %s — skipping image. Use the URL above.\n" "$HC" >&2
  fi
  echo

  # --- 3b. Terminal QR ----------------------------------------------------
  printf "${BOLD}QR code (terminal)${RESET}  ${DIM}hold your laptop up — Alan can scan from screen${RESET}\n"
  ASCII_QR=$(curl "${CURL_OPTS[@]}" "https://qrenco.de/${SHARE_URL}" 2>/dev/null)
  if [[ -n "$ASCII_QR" ]]; then
    printf "%s\n" "$ASCII_QR"
  else
    printf "${YELLOW}  qrenco.de unreachable — skipped. PNG above still works.${RESET}\n"
  fi
fi

printf "\n${DIM}re-run anytime; if the tunnel rotates, the watchdog will update data/tunnel-state.json and this script will pick it up.${RESET}\n"
