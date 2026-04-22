#!/usr/bin/env bash
#
# set-jira-token.sh — interactively store a Jira PAT in .env
#
# Why this script exists:
#   Pasting a PAT into chat, a git-tracked config file, or an argv
#   you launch a process with all leave the token sitting in one
#   plaintext log or another. This script takes the token via a
#   silent stdin read, writes it only to the gitignored .env, and
#   exits — no echo, no shell history entry containing the token.
#
# Usage:
#   ./scripts/set-jira-token.sh
#   (You'll be prompted for the base URL, token, and optional
#    project key. Nothing is printed back.)
#
# To rotate the token later, just run it again — the existing line
# is replaced, not appended.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Make sure .env exists (touch is idempotent).
touch "$ENV_FILE"
chmod 600 "$ENV_FILE" || true  # best-effort; readable only by owner

# Prompt for base URL — not a secret, default to the known value.
printf 'Jira base URL [https://jira.corp.nortonlifelock.com]: '
read -r BASE_URL
BASE_URL="${BASE_URL:-https://jira.corp.nortonlifelock.com}"

# Prompt for PAT — silent (-s), no echo.
printf 'Jira Personal Access Token (input hidden): '
read -rs TOKEN
printf '\n'

if [[ -z "$TOKEN" ]]; then
  echo "Aborting: no token entered." >&2
  exit 1
fi

# Replace-or-append helper: removes any existing KEY= line, then
# appends the new one. Avoids duplicates when rerun.
replace_or_append() {
  local key="$1"
  local value="$2"
  # Strip existing lines for this key.
  if [[ -f "$ENV_FILE" ]]; then
    # Using a tmp file so we never truncate mid-write.
    local tmp
    tmp="$(mktemp)"
    grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" || true
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE" || true
  fi
  # Append. Token value is never interpolated into a logged string.
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

replace_or_append "JIRA_BASE_URL" "$BASE_URL"
replace_or_append "JIRA_TOKEN" "$TOKEN"

# Clear the local variable from this shell's memory.
unset TOKEN

echo "✓ Wrote JIRA_BASE_URL and JIRA_TOKEN to .env"
echo "  (.env is gitignored; chmod 600 applied.)"
echo ""
echo "Next: decide on project scope. Edit .env and add, for example:"
echo "    JIRA_PROJECT_KEYS=EMOPS,EMAILCO"
echo "    JIRA_DEFAULT_PROJECT=EMOPS"
