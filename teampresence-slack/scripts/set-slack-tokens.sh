#!/usr/bin/env bash
#
# set-slack-tokens.sh — interactively store Slack app credentials in .env
#
# Why this script exists:
#   Pasting bot tokens / signing secrets into chat, a git-tracked config
#   file, or an argv you launch a process with all leave the credential
#   sitting in one plaintext log or another. This script takes each
#   value via a silent stdin read, writes only to the gitignored .env,
#   and exits — no echo, no shell history entry containing secrets.
#
# Usage:
#   ./scripts/set-slack-tokens.sh
#
#   You'll be prompted for:
#     - SLACK_BOT_TOKEN       (xoxb-...)  — required
#     - SLACK_SIGNING_SECRET  (hex-ish)   — required
#     - SLACK_APP_TOKEN       (xapp-...)  — optional, only if Socket Mode
#
#   After it finishes, it flips PRESENCE_MODEL to "slack+workday" so the
#   restart-then-refresh cycle is one extra step, not three.
#
# To rotate a credential later, just run it again — existing lines are
# replaced, not appended.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

touch "$ENV_FILE"
chmod 600 "$ENV_FILE" || true

printf 'Slack Bot Token (xoxb-..., input hidden): '
read -rs BOT
printf '\n'
if [[ -z "${BOT:-}" ]]; then
  echo "Aborting: no bot token entered." >&2
  exit 1
fi
if [[ "$BOT" != xoxb-* ]]; then
  echo "Warning: bot token doesn't start with 'xoxb-'. Continuing anyway." >&2
fi

printf 'Slack Signing Secret (input hidden): '
read -rs SECRET
printf '\n'
if [[ -z "${SECRET:-}" ]]; then
  echo "Aborting: no signing secret entered." >&2
  exit 1
fi

printf 'Slack App Token (xapp-..., Socket Mode only — press enter to skip): '
read -rs APP
printf '\n'
if [[ -n "${APP:-}" && "$APP" != xapp-* ]]; then
  echo "Warning: app token doesn't start with 'xapp-'. Continuing anyway." >&2
fi

replace_or_append() {
  local key="$1"
  local value="$2"
  if [[ -f "$ENV_FILE" ]]; then
    local tmp
    tmp="$(mktemp)"
    grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" || true
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE" || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

replace_or_append "SLACK_BOT_TOKEN" "$BOT"
replace_or_append "SLACK_SIGNING_SECRET" "$SECRET"
if [[ -n "${APP:-}" ]]; then
  replace_or_append "SLACK_APP_TOKEN" "$APP"
  replace_or_append "SLACK_SOCKET_MODE" "true"
fi

# Flip presence to the combined model so Slack lights up on next restart.
# We intentionally keep workday in the mix — Workday vacations should
# still override Slack "auto-active" when someone forgets to set their
# status before going on PTO.
replace_or_append "PRESENCE_MODEL" "slack+workday"

unset BOT SECRET APP

echo "✓ Wrote SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET$([[ -n "${APP:-}" ]] && echo ", SLACK_APP_TOKEN")"
echo "✓ Set PRESENCE_MODEL=slack+workday"
echo "  (.env is gitignored; chmod 600 applied.)"
echo ""
echo "Next:"
echo "  1. pkill -9 -f 'node src/index.js'"
echo "  2. PORT=3000 node src/index.js &"
echo "  3. Open http://localhost:3000/?key=\$(awk -F= '/^DASHBOARD_KEY=/{print \$2}' .env)"
echo ""
echo "If Team Presence shows fewer real rows than expected, fill in the"
echo "missing slackIds: [...] arrays in src/team.js."
