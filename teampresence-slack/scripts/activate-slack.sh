#!/usr/bin/env bash
# ============================================================
# activate-slack.sh — one-shot Slack integration activator.
#
# Run this the moment workspace-admin approval lands for the
# Gen Pulse Slack app. It will:
#
#   1. Validate the tokens you paste look like real Slack tokens.
#   2. Call Slack's auth.test to verify the bot can talk to the
#      workspace. If that fails, we bail before touching anything.
#   3. Back up .env to .env.<timestamp>.bak.
#   4. Write SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET / (optional)
#      SLACK_APP_TOKEN into .env, replacing the placeholders from
#      .env.example.
#   5. Flip PRESENCE_MODEL to "slack+workday".
#   6. Call scripts/map-slack-users.mjs --write to build
#      data/slack-overrides.json from users.list (matches roster
#      by name). src/team.js picks this up at boot automatically.
#   7. Restart the server (kill anything on :3000, respawn under
#      nohup into /tmp/gen-pulse/server.log).
#   8. Smoke-test /api/team and print a before/after summary so
#      you can confirm presence dots / avatars are live.
#
# USAGE
#   # Interactive — will prompt for each token:
#   ./scripts/activate-slack.sh
#
#   # Flags (any combination — missing ones will prompt):
#   ./scripts/activate-slack.sh \
#       --bot-token xoxb-... \
#       --signing-secret abcdef... \
#       --app-token xapp-...     # optional, for Socket Mode
#
#   # Dry run — validates tokens + prints proposed mapping, does
#   # not touch .env / data/ / server:
#   ./scripts/activate-slack.sh --dry-run
#
# SAFETY
#   - Nothing is written until auth.test succeeds.
#   - .env is backed up every run. To revert, copy the newest
#     .env.<timestamp>.bak back over .env and restart.
#   - data/slack-overrides.json is gitignored; real Slack IDs
#     never reach the repo.
#
# EXIT CODES
#   0  activated (or dry-run completed successfully)
#   1  bad arguments or missing prerequisites
#   2  auth.test failed — token is wrong or revoked
#   3  user-mapping found 0 roster matches
#   4  server did not come up on :3000 after restart
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

BOT_TOKEN=""
SIGNING_SECRET=""
APP_TOKEN=""
DRY_RUN=0
ASSUME_YES=0

usage() {
  sed -n '2,42p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token)       BOT_TOKEN="$2"; shift 2 ;;
    --signing-secret)  SIGNING_SECRET="$2"; shift 2 ;;
    --app-token)       APP_TOKEN="$2"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    -h|--help)         usage 0 ;;
    *)                 echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done

# ---------- pretty printers ----------
say()  { printf "\033[1;34m[activate]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ ok ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit "${2:-1}"; }

# ---------- 1. collect tokens ----------
prompt_secret() {
  local varname="$1" label="$2" hint="$3"
  if [[ -n "${!varname:-}" ]]; then return; fi
  if [[ ! -t 0 ]]; then
    die "$varname not provided and stdin is not a TTY — pass --$(echo "$varname" | tr '[:upper:]_' '[:lower:]-' | sed 's/^slack-//')" 1
  fi
  printf "%s" "$label"
  [[ -n "$hint" ]] && printf " \033[2m(%s)\033[0m" "$hint"
  printf ": "
  read -rs value
  printf "\n"
  printf -v "$varname" '%s' "$value"
}

prompt_secret BOT_TOKEN "SLACK_BOT_TOKEN" "xoxb-..."
# Signing secret + app token aren't needed for a dry-run (auth.test + users.list
# only require the bot token), so skip those prompts.
if [[ $DRY_RUN -ne 1 ]]; then
  prompt_secret SIGNING_SECRET "SLACK_SIGNING_SECRET" "hex"
  prompt_secret APP_TOKEN      "SLACK_APP_TOKEN"      "xapp-... (optional, press enter to skip)"
fi

[[ -z "$BOT_TOKEN" ]] && die "SLACK_BOT_TOKEN is required" 1
if [[ $DRY_RUN -ne 1 ]]; then
  [[ -z "$SIGNING_SECRET" ]] && die "SLACK_SIGNING_SECRET is required" 1
fi

# ---------- 2. shape validation ----------
[[ "$BOT_TOKEN" =~ ^xoxb-[0-9A-Za-z-]+$ ]]   || die "SLACK_BOT_TOKEN doesn't look like xoxb-*" 1
[[ "$SIGNING_SECRET" =~ ^[0-9a-f]{24,64}$ ]] || warn "SLACK_SIGNING_SECRET doesn't look like a hex string — continuing anyway"
if [[ -n "$APP_TOKEN" ]]; then
  [[ "$APP_TOKEN" =~ ^xapp-[0-9A-Za-z-]+$ ]] || die "SLACK_APP_TOKEN doesn't look like xapp-*" 1
fi

# ---------- 3. live auth.test ----------
say "verifying bot token with Slack auth.test …"
AUTH_JSON="$(curl -sSf -H "Authorization: Bearer $BOT_TOKEN" \
  https://slack.com/api/auth.test || true)"
AUTH_OK="$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))' 2>/dev/null || echo "false")"
if [[ "$AUTH_OK" != "True" ]]; then
  ERR="$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error","?"))' 2>/dev/null || echo '?')"
  die "auth.test failed: $ERR  — token may be wrong, revoked, or not yet approved" 2
fi
WORKSPACE="$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("team","?"))')"
BOT_USER="$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("user","?"))')"
ok "authenticated as \"$BOT_USER\" in workspace \"$WORKSPACE\""

# ---------- 4. dry-run shortcut ----------
if [[ $DRY_RUN -eq 1 ]]; then
  say "dry-run: showing proposed slug→slackId mapping only"
  SLACK_BOT_TOKEN="$BOT_TOKEN" node "$SCRIPT_DIR/map-slack-users.mjs"
  ok "dry-run complete — nothing written"
  exit 0
fi

# ---------- 5. confirm ----------
if [[ $ASSUME_YES -ne 1 ]]; then
  echo
  echo "About to:"
  echo "  - back up .env  →  .env.$(date +%Y%m%d-%H%M%S).bak"
  echo "  - write SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET${APP_TOKEN:+, SLACK_APP_TOKEN} to .env"
  echo "  - set PRESENCE_MODEL=slack+workday in .env"
  echo "  - write data/slack-overrides.json from Slack users.list"
  echo "  - restart the server on :3000"
  read -rp "Proceed? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || die "aborted by user" 1
fi

# ---------- 6. back up + patch .env ----------
BACKUP=".env.$(date +%Y%m%d-%H%M%S).bak"
cp .env "$BACKUP"
ok "backed up .env → $BACKUP"

python3 - <<PYEOF
import re, sys, os
p = ".env"
with open(p, "r", encoding="utf-8") as f:
    text = f.read()

def upsert(text, key, value, comment=None):
    # Replace first occurrence (commented or not). If no match, append.
    pat = re.compile(r"^#?\s*" + re.escape(key) + r"=.*$", re.M)
    line = f"{key}={value}"
    if pat.search(text):
        text = pat.sub(line, text, count=1)
    else:
        if not text.endswith("\n"):
            text += "\n"
        if comment:
            text += f"\n# {comment}\n"
        text += line + "\n"
    return text

text = upsert(text, "SLACK_BOT_TOKEN",      os.environ["BOT_TOKEN"])
text = upsert(text, "SLACK_SIGNING_SECRET", os.environ["SIGNING_SECRET"])
if os.environ.get("APP_TOKEN"):
    text = upsert(text, "SLACK_APP_TOKEN",  os.environ["APP_TOKEN"])
text = upsert(text, "PRESENCE_MODEL",       "slack+workday",
              comment="Flipped by scripts/activate-slack.sh")

with open(p, "w", encoding="utf-8") as f:
    f.write(text)
PYEOF
export BOT_TOKEN SIGNING_SECRET APP_TOKEN
ok "patched .env (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET${APP_TOKEN:+, SLACK_APP_TOKEN}, PRESENCE_MODEL)"

# ---------- 7. build slack-overrides.json ----------
say "mapping Slack users → roster slugs …"
SLACK_BOT_TOKEN="$BOT_TOKEN" node "$SCRIPT_DIR/map-slack-users.mjs" --write
ok "data/slack-overrides.json written"

# ---------- 8. restart server ----------
say "restarting server on :3000 …"
pids=$(lsof -ti tcp:3000 2>/dev/null || true)
for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
sleep 2
mkdir -p /tmp/gen-pulse
# Use the same invocation the demo wrapper uses so behaviour matches.
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" PORT=3000 \
  nohup node src/index.js > /tmp/gen-pulse/server.log 2>&1 &
disown
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if lsof -iTCP:3000 -sTCP:LISTEN -nP >/dev/null 2>&1; then
    ok "server up on :3000 (pid $(lsof -ti tcp:3000 | head -1))"
    break
  fi
  if [[ $i -eq 10 ]]; then
    die "server did not come up in 10s — see /tmp/gen-pulse/server.log" 4
  fi
done

# ---------- 9. smoke test ----------
say "smoke-testing /api/team …"
KEY="$(awk -F= '/^DASHBOARD_KEY=/{print $2}' .env)"
SUMMARY="$(curl -sS "http://localhost:3000/api/team?key=$KEY" | python3 - <<'PYEOF'
import sys, json
d = json.load(sys.stdin)
members = d.get("members", []) or []
with_slack = sum(1 for m in members if (m.get("slackStatus") or {}).get("source") == "slack")
with_avatar = sum(1 for m in members if (m.get("avatarUrl") or "").startswith(("http://","https://")))
print(f"  model={d.get('model')}  members={len(members)}  slack-driven={with_slack}  live-avatars={with_avatar}")
PYEOF
)"
echo "$SUMMARY"

if [[ "$SUMMARY" == *"slack-driven=0"* ]]; then
  warn "model flipped but 0 members are slack-driven yet."
  warn "check that the 8 EMAIL NORTON people are actually members of the '$WORKSPACE' workspace."
  warn "re-run \`node scripts/map-slack-users.mjs --show-unmatched\` to see who Slack returned."
fi

ok "activation complete. Dashboard: http://localhost:3000/?key=$KEY"
