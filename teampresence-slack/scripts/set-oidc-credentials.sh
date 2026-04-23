#!/usr/bin/env bash
#
# set-oidc-credentials.sh — interactively store Azure AD app credentials
# in .env without ever echoing them or leaking into shell history.
#
# Same security posture as set-jira-token.sh / set-slack-tokens.sh:
#   - values are read with `read -rs` (silent, no echo, no history)
#   - writes only to the gitignored .env file, chmod 600
#   - existing lines for the same keys are replaced, not appended
#
# Usage:
#   ./scripts/set-oidc-credentials.sh
#
# Prompts for:
#   OIDC_TENANT_ID       — Azure AD Directory (tenant) ID, GUID
#   OIDC_CLIENT_ID       — Azure AD Application (client) ID, GUID
#   OIDC_CLIENT_SECRET   — the Value from the client secret (not the ID!)
#   OIDC_REDIRECT_URI    — defaults to http://localhost:3000/auth/callback
#
# Auto-generates:
#   OIDC_SESSION_SECRET  — 64 hex chars, fresh each run (rotates sessions)
#
# Auto-sets:
#   AUTH_STRATEGY=oidc
#
# After the script, you still need to add OIDC_ROLE_MAP_* lines for
# each Azure AD security group GUID → role mapping. See
# AZURE-AD-ADMIN-REQUEST.md for the template.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

touch "$ENV_FILE"
chmod 600 "$ENV_FILE" || true

printf 'Azure AD Tenant ID (GUID, input hidden): '
read -rs TENANT
printf '\n'
if [[ -z "${TENANT:-}" ]]; then echo "Aborting: no tenant id." >&2; exit 1; fi

printf 'Azure AD Client ID  (GUID, input hidden): '
read -rs CLIENT
printf '\n'
if [[ -z "${CLIENT:-}" ]]; then echo "Aborting: no client id." >&2; exit 1; fi

printf 'Azure AD Client Secret (the VALUE, not the Secret ID, input hidden): '
read -rs SECRET
printf '\n'
if [[ -z "${SECRET:-}" ]]; then echo "Aborting: no client secret." >&2; exit 1; fi

# Redirect URI — most callers want the localhost default, so offer it.
DEFAULT_URI="http://localhost:3000/auth/callback"
printf 'Redirect URI [%s]: ' "$DEFAULT_URI"
# Echo IS okay here — a URL isn't a secret.
read -r URI
URI="${URI:-$DEFAULT_URI}"

# Session secret — we rotate this on every run, which invalidates any
# already-issued cookies. That's intentional: if you're re-setting
# credentials, you probably want a clean session-state reset too.
SESSION_SECRET="$(openssl rand -hex 32)"

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

replace_or_append "AUTH_STRATEGY"      "oidc"
replace_or_append "OIDC_TENANT_ID"     "$TENANT"
replace_or_append "OIDC_CLIENT_ID"     "$CLIENT"
replace_or_append "OIDC_CLIENT_SECRET" "$SECRET"
replace_or_append "OIDC_REDIRECT_URI"  "$URI"
replace_or_append "OIDC_SESSION_SECRET" "$SESSION_SECRET"

unset TENANT CLIENT SECRET SESSION_SECRET

echo "✓ Wrote OIDC_TENANT_ID, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET"
echo "✓ Wrote OIDC_REDIRECT_URI=$URI"
echo "✓ Generated fresh OIDC_SESSION_SECRET (64 hex chars)"
echo "✓ Set AUTH_STRATEGY=oidc"
echo "  (.env is gitignored; chmod 600 applied.)"
echo ""
echo "Next steps:"
echo "  1. Add OIDC_ROLE_MAP_* lines to .env for each Azure AD group GUID"
echo "     (see AZURE-AD-ADMIN-REQUEST.md for the template)"
echo ""
echo "  2. If you want shared-key DASHBOARD_KEY to still authenticate"
echo "     non-browser callers (curl, slack slash-commands) during"
echo "     rollout, also add:"
echo "       OIDC_ALLOW_SHARED_KEY_FALLBACK=true"
echo ""
echo "  3. Restart the server and verify:"
echo "       pkill -9 -f 'node src/index.js'"
echo "       PORT=3000 node src/index.js &"
echo "       sleep 3"
echo "       curl -s http://localhost:3000/auth/status | python3 -m json.tool"
echo "       # Expect: \"strategy\": \"oidc\", \"enabled\": true"
echo ""
echo "  4. Open http://localhost:3000/ — you should see a 'Sign in with"
echo "     Microsoft' pill top-right. Click it, sign in, and you're done."
