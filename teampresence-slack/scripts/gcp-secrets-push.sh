#!/usr/bin/env bash
# gcp-secrets-push.sh — mirror the 6 Gen Pulse runtime secrets from .env
# into Google Secret Manager, idempotently.
#
# WHY this script exists:
#   Cloud Run never reads .env; it reads Secret Manager references
#   passed via `gcloud run deploy --set-secrets`. Every time a secret
#   is rotated (Azure AD client_secret expires yearly, Slack bot
#   token is rotated on offboarding, etc.) you re-run this script
#   and the next Cloud Run revision picks up the new version.
#
# USAGE:
#   scripts/gcp-secrets-push.sh --project-id <PROJECT_ID> [options]
#
# OPTIONS:
#   --project-id <id>   REQUIRED. GCP project where secrets live.
#   --env-file <path>   Source .env (default: ./.env)
#   --prefix <str>      Secret-name prefix (default: gen-pulse)
#   --dry-run           Print what would happen, don't touch Secret Manager.
#   --only <name,...>   Only push these secrets (comma-separated, matches the
#                       SECRET_MAP keys below). Default: all 6.
#   -h | --help         This help.
#
# EXIT CODES:
#   0  ok — all secrets up-to-date or new versions added
#   1  bad args / missing dependencies
#   2  .env doesn't contain a required key
#   3  gcloud not authenticated or project not accessible
#   4  Secret Manager API call failed
#
# SECURITY:
#   - Secret values never appear in shell history or logs; we pass them
#     via `gcloud secrets versions add --data-file=-` and pipe stdin.
#   - We grep the values out of .env via bash parameter expansion — no
#     `source .env` (which would export everything, including tokens,
#     into this script's environment and a child gcloud call).
#   - If a secret hasn't changed since the last push, we skip adding
#     a new version to avoid stacking redundant revisions.

set -euo pipefail

# ---------- 1. defaults + CLI parsing -------------------------------------

PROJECT_ID=""
ENV_FILE="./.env"
PREFIX="gen-pulse"
DRY_RUN=0
ONLY=""

die() { echo "error: $*" >&2; exit "${2:-1}"; }
info() { echo "[gcp-secrets] $*"; }

usage() {
  # Portable across BSD sed (macOS) and GNU sed (Linux). awk is the
  # common denominator — skip the shebang, strip "# " from each
  # subsequent comment line, stop at the first non-comment line.
  awk 'NR==1{next} /^[^#]/{exit} {sub(/^# ?/,""); print}' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id)  PROJECT_ID="${2:-}"; shift 2 ;;
    --env-file)    ENV_FILE="${2:-}";   shift 2 ;;
    --prefix)      PREFIX="${2:-}";     shift 2 ;;
    --only)        ONLY="${2:-}";       shift 2 ;;
    --dry-run)     DRY_RUN=1;           shift ;;
    -h|--help)     usage ;;
    *) die "unknown flag: $1 (try --help)" 1 ;;
  esac
done

[[ -n "$PROJECT_ID" ]] || die "--project-id is required" 1
[[ -f "$ENV_FILE" ]]   || die ".env not found at $ENV_FILE" 2
command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not installed" 1

# ---------- 2. verify gcloud auth + project access ------------------------

# `gcloud projects describe` 200s only when (a) the caller is authed and
# (b) has at least resourcemanager.projects.get on the project. Fails fast
# with a clear message if they forgot `gcloud auth login` before running.
if ! gcloud projects describe "$PROJECT_ID" --format='value(projectId)' \
      >/dev/null 2>&1; then
  die "can't access project '$PROJECT_ID' — run 'gcloud auth login' and confirm the project id" 3
fi
info "project:   $PROJECT_ID"
info "env file:  $ENV_FILE"
info "prefix:    $PREFIX"
[[ $DRY_RUN -eq 1 ]] && info "mode:      DRY-RUN (no changes will be made)"

# ---------- 3. the map of .env-key -> secret-name -------------------------

# Keep this in lock-step with `--set-secrets` in scripts/gcp-deploy.sh.
# Ordering is cosmetic (shown in the summary); semantic is purely by key.
SECRET_MAP=(
  # env-var-name          short-name-appended-to-prefix
  "JIRA_TOKEN             jira-token"
  "SLACK_BOT_TOKEN        slack-bot-token"
  "SLACK_SIGNING_SECRET   slack-signing-secret"
  "OIDC_CLIENT_SECRET     oidc-client-secret"
  "OIDC_SESSION_SECRET    oidc-session-secret"
  "DASHBOARD_KEY          dashboard-key"
)

# Convert --only="a,b" into an associative lookup, empty = all.
declare -A ONLY_SET
if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a arr <<< "$ONLY"
  for x in "${arr[@]}"; do ONLY_SET["$x"]=1; done
fi

# ---------- 4. helpers ----------------------------------------------------

# Read a single KEY=VALUE from the env file without sourcing it. Handles
# values with spaces, quotes, and '=' characters. Returns the raw value.
env_get() {
  local key="$1" file="$2"
  # awk is both POSIX-portable and immune to the `source` side effects we
  # explicitly want to avoid. Only the *first* match is returned so a
  # commented-out duplicate line lower in the file can't override.
  awk -v k="^${key}=" 'match($0,k){sub(k,""); print; exit}' "$file"
}

# True if the remote secret's current version matches the local bytes
# exactly. Saves a redundant version every deploy.
secret_matches() {
  local name="$1" local_value="$2"
  # `gcloud secrets versions access latest` prints the raw bytes. If the
  # secret doesn't exist yet, it exits non-zero and we treat that as a
  # mismatch (so the create path below runs).
  local remote
  remote="$(gcloud secrets versions access latest \
              --secret="$name" --project="$PROJECT_ID" 2>/dev/null || true)"
  [[ "$remote" == "$local_value" ]]
}

# Create the secret resource if it doesn't yet exist. Idempotent.
ensure_secret() {
  local name="$1"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" \
       >/dev/null 2>&1; then
    return 0
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    info "  would create secret '$name' (replication=automatic, labels=app=gen-pulse)"
    return 0
  fi
  # Labels help inventory ("give me all gen-pulse secrets") and cost
  # attribution. Automatic replication is the default for regional
  # deploys — acceptable unless NEMO's policy forces user-managed keys.
  gcloud secrets create "$name" \
    --project="$PROJECT_ID" \
    --replication-policy=automatic \
    --labels=app=gen-pulse,managed-by=gcp-secrets-push \
    >/dev/null
}

# Add a new version of the secret with the given value, via stdin to
# avoid ever putting the value on a command line or in shell history.
add_version() {
  local name="$1" value="$2"
  if [[ $DRY_RUN -eq 1 ]]; then
    info "  would add new version to '$name' (${#value} bytes)"
    return 0
  fi
  printf '%s' "$value" \
    | gcloud secrets versions add "$name" \
        --project="$PROJECT_ID" \
        --data-file=- \
        >/dev/null \
    || die "failed to add version for $name" 4
}

# ---------- 5. main loop --------------------------------------------------

added=0 skipped=0 missing=0

echo ""
for line in "${SECRET_MAP[@]}"; do
  # shellcheck disable=SC2206
  parts=( $line )
  env_key="${parts[0]}"
  short="${parts[1]}"
  name="${PREFIX}-${short}"

  if [[ -n "$ONLY" && -z "${ONLY_SET[$short]:-}" ]]; then
    continue
  fi

  val="$(env_get "$env_key" "$ENV_FILE" || true)"
  if [[ -z "$val" ]]; then
    echo "  [MISSING] $env_key not set in $ENV_FILE — skipping"
    missing=$((missing+1))
    continue
  fi

  # Strip surrounding single/double quotes if present (dotenv-style).
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"

  ensure_secret "$name"

  if secret_matches "$name" "$val"; then
    echo "  [unchanged] $name  (latest version matches .env)"
    skipped=$((skipped+1))
  else
    add_version "$name" "$val"
    echo "  [pushed]    $name  (${#val} bytes)"
    added=$((added+1))
  fi
done
echo ""

info "summary: pushed=$added  unchanged=$skipped  missing=$missing"
if [[ $missing -gt 0 && -z "$ONLY" ]]; then
  die "one or more required keys were missing from $ENV_FILE" 2
fi

# ---------- 6. post-check -------------------------------------------------
# Surface the full secret inventory the Cloud Run service will consume
# so the operator sees exactly what --set-secrets needs to reference.

if [[ $DRY_RUN -eq 0 ]]; then
  echo ""
  info "secret inventory for project $PROJECT_ID (name → latest version):"
  gcloud secrets list \
    --project="$PROJECT_ID" \
    --filter="labels.app=gen-pulse" \
    --format='table(name.basename(), createTime.date(),
                    labels.managed_by:label="MANAGED-BY")' \
    2>/dev/null || true
fi

info "done."
