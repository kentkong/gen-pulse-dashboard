#!/usr/bin/env bash
# ============================================================================
# verify-slack.sh
# ----------------------------------------------------------------------------
# Sanity-check the Slack credentials currently in .env *before* you
# bounce the running server. The default failure mode for a typo'd
# bot token is "no Slack data on the dashboard" — which we'd notice
# only after the demo started. This script catches it in one second.
#
# What it does:
#   1. Reads SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET from .env (no
#      echo of values to stdout).
#   2. Shape-checks both: bot token starts with "xoxb-" and looks
#      long enough; signing secret is the right length / charset.
#   3. Calls https://slack.com/api/auth.test with the bot token.
#      A success response confirms the token is valid AND that the
#      workspace + bot user are reachable.
#   4. (Optional) If --roster is passed, walks the team roster and
#      verifies every configured slackId resolves via users.info.
#
# Does NOT: write anything, restart the server, or print secret values.
# Safe to run any time — it's a read-only probe.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

ENV_FILE=".env"

GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; YELLOW=$'\033[1;33m'
DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

CHECK_ROSTER=0
[[ "${1:-}" == "--roster" ]] && CHECK_ROSTER=1

# Corporate cert bundle for HTTPS through MITM inspection.
CACERT="${CACERT:-/Users/kevin.mold/.certs/corporate-bundle.pem}"
CURL_OPTS=(--silent --show-error --max-time 10)
[ -f "$CACERT" ] && CURL_OPTS+=(--cacert "$CACERT")

read_env() {
  # Strip surrounding quotes if present, no shell expansion of value.
  awk -F= -v k="$1" '$1==k {v=$2; gsub(/^"|"$/,"",v); print v; exit}' "$ENV_FILE"
}

BOT=$(read_env SLACK_BOT_TOKEN)
SECRET=$(read_env SLACK_SIGNING_SECRET)

printf "${BOLD}Slack credential probe${RESET}  ${DIM}(read-only, no restart)${RESET}\n\n"

# --- 1. Shape checks ------------------------------------------------------
fail_count=0
shape_ok() { printf "  ${GREEN}✓${RESET}  %-32s ${DIM}%s${RESET}\n" "$1" "$2"; }
shape_warn() { printf "  ${YELLOW}!${RESET}  %-32s %s\n" "$1" "$2"; }
shape_fail() { printf "  ${RED}✗${RESET}  %-32s %s\n" "$1" "$2"; fail_count=$((fail_count+1)); }

printf "${BOLD}1. Shape${RESET}\n"
if [[ -z "$BOT" ]]; then
  shape_fail "SLACK_BOT_TOKEN present" "missing in $ENV_FILE"
elif [[ "$BOT" != xoxb-* ]]; then
  shape_fail "SLACK_BOT_TOKEN format" "doesn't start with 'xoxb-' (got first 6 chars: '${BOT:0:6}')"
elif (( ${#BOT} < 40 )); then
  shape_fail "SLACK_BOT_TOKEN length"  "too short: ${#BOT} chars (real tokens are 50-80)"
else
  shape_ok   "SLACK_BOT_TOKEN format"  "xoxb-… ${#BOT} chars"
fi

if [[ -z "$SECRET" ]]; then
  shape_fail "SLACK_SIGNING_SECRET present" "missing in $ENV_FILE"
elif [[ "$SECRET" =~ ^PLACEH ]]; then
  shape_fail "SLACK_SIGNING_SECRET real" "still a PLACEHOLDER value — paste the real one"
elif [[ ! "$SECRET" =~ ^[0-9a-f]{24,64}$ ]]; then
  shape_warn "SLACK_SIGNING_SECRET shape" "expected 32 hex chars; got ${#SECRET} chars (Slack may have changed format)"
else
  shape_ok   "SLACK_SIGNING_SECRET shape" "${#SECRET} hex chars"
fi

if (( fail_count > 0 )); then
  printf "\n${RED}${BOLD}%d shape problem(s) — fix .env before retesting.${RESET}\n" "$fail_count"
  exit 1
fi

# --- 2. auth.test ----------------------------------------------------------
printf "\n${BOLD}2. Live token test (slack.com/api/auth.test)${RESET}\n"
RESP=$(curl "${CURL_OPTS[@]}" -X POST \
  -H "Authorization: Bearer $BOT" \
  -H "Content-Type: application/x-www-form-urlencoded; charset=utf-8" \
  "https://slack.com/api/auth.test" 2>/dev/null)

OK=$(printf "%s" "$RESP" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read() or "{}"); print("true" if d.get("ok") else "false")' 2>/dev/null)
if [[ "$OK" != "true" ]]; then
  ERR=$(printf "%s" "$RESP" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read() or "{}"); print(d.get("error") or "no_response")' 2>/dev/null)
  shape_fail "auth.test" "Slack returned error=${ERR}"
  printf "\n${RED}${BOLD}Token rejected by Slack.${RESET}  Common fixes:\n"
  printf "  ${DIM}• ${RESET}error=${BOLD}invalid_auth${RESET}  → token typo or revoked. Re-run set-slack-tokens.sh.\n"
  printf "  ${DIM}• ${RESET}error=${BOLD}token_revoked${RESET}  → admin invalidated this token; generate a fresh one.\n"
  printf "  ${DIM}• ${RESET}error=${BOLD}account_inactive${RESET}  → bot user suspended; reinstall the app.\n"
  exit 1
fi

# Extract identity fields (no secret, just metadata)
TEAM=$(printf "%s" "$RESP" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("team","?"))')
USER=$(printf "%s" "$RESP" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("user","?"))')
TEAM_ID=$(printf "%s" "$RESP" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("team_id","?"))')
URL=$(printf "%s" "$RESP" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d.get("url","?"))')
shape_ok "auth.test" "team=${TEAM} (${TEAM_ID}) bot=${USER}"
shape_ok "workspace url"          "$URL"

# --- 3. Optional roster walk ----------------------------------------------
if (( CHECK_ROSTER )); then
  printf "\n${BOLD}3. Roster slackId resolution${RESET}\n"
  IDS=$(node -e "
    const team = require('./src/team.js');
    const arr = (team.default || team.team || team.TEAM || team).flatMap?.(p => p.slackIds || []) ?? [];
    process.stdout.write([...new Set(arr)].join('\n'));
  " 2>/dev/null)
  if [[ -z "$IDS" ]]; then
    shape_warn "roster slackIds" "no slackIds configured in src/team.js"
  else
    while IFS= read -r id; do
      [[ -z "$id" ]] && continue
      R=$(curl "${CURL_OPTS[@]}" -X POST \
        -H "Authorization: Bearer $BOT" \
        -H "Content-Type: application/x-www-form-urlencoded; charset=utf-8" \
        --data-urlencode "user=$id" \
        "https://slack.com/api/users.info" 2>/dev/null)
      ROK=$(printf "%s" "$R" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read() or "{}"); print("true" if d.get("ok") else "false")' 2>/dev/null)
      if [[ "$ROK" == "true" ]]; then
        NAME=$(printf "%s" "$R" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); u=d.get("user",{}); p=u.get("profile",{}); print(p.get("real_name") or u.get("name") or "?")')
        shape_ok "users.info $id" "$NAME"
      else
        ERR=$(printf "%s" "$R" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read() or "{}"); print(d.get("error") or "?")')
        shape_warn "users.info $id" "$ERR"
      fi
    done <<<"$IDS"
  fi
fi

printf "\n${GREEN}${BOLD}Slack credentials look healthy.${RESET}  Safe to restart the server.\n"
printf "${DIM}Next: pkill -9 -f 'node src/index.js' && nohup PORT=3000 node src/index.js >> /tmp/gen-pulse/server.log 2>&1 & disown${RESET}\n"
