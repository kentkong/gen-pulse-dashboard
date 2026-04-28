#!/usr/bin/env bash
# gcp-deploy.sh — one-shot build → push → deploy for Gen Pulse on Cloud Run.
#
# WHY this script exists:
#   Every `gcloud run deploy` command on this project has 20+ flags
#   (region, service account, secrets bindings, env-vars file, CPU,
#   memory, ingress, concurrency, timeout, min/max instances, …).
#   Typing that by hand is where outages come from. This script pins
#   every flag, validates .env before touching GCP, and fails fast
#   with actionable errors instead of mid-deploy stack traces.
#
# WHAT it does (in order):
#   1. Validates prerequisites (gcloud, docker, .env, project access).
#   2. Ensures Artifact Registry repo + Secret Manager entries exist.
#   3. Splits .env into secrets (pushed via gcp-secrets-push.sh) and
#      non-secrets (rendered to a temp env-vars.yaml consumed by
#      `gcloud run deploy --env-vars-file`).
#   4. Builds the Docker image locally and pushes to Artifact Registry.
#   5. Deploys a new Cloud Run revision with the env-vars + secret
#      bindings in place.
#   6. Prints the service URL + a smoke-test curl for /healthz.
#
# USAGE:
#   scripts/gcp-deploy.sh --project-id <ID> [options]
#
# REQUIRED (one of):
#   --project-id <id>       GCP project id from RITM0214505, OR
#   `gcloud config set project <id>` set beforehand — the script will
#   pick that up automatically so you can run it with zero flags.
#
# OPTIONAL (with sensible defaults):
#   --region <name>         Default: europe-west3 (Frankfurt — closest to
#                           Gen Digital Prague/DE).
#   --service <name>        Default: gen-pulse.
#   --repo <name>           Artifact Registry docker repo name. Default: gen-pulse.
#   --tag <str>             Image tag. Default: timestamp (e.g. 20260428-1530).
#   --env-file <path>       Source .env. Default: ./.env.
#   --ingress <mode>        all | internal | internal-and-cloud-load-balancing.
#                           Default: all. Per company data-safety review,
#                           in-app Azure AD OIDC gates every request and
#                           this matches what InfoSec approved for
#                           RITM0213874. Switch to
#                           `internal-and-cloud-load-balancing` only if
#                           InfoSec later requires IAP (which needs the
#                           extra IAM roles not on RITM0214505).
#   --runtime-sa <email>    Runtime service account (deploy as). Default:
#                           gen-pulse-run@<project>.iam.gserviceaccount.com
#                           (created on first run if missing).
#   --use-local-docker      Build the image locally with `docker build` and
#                           push via `docker push`. Requires a running
#                           Docker daemon. Default is Cloud Build, which
#                           works without local Docker — GCP builds the
#                           image from a source tarball on its own
#                           infrastructure (requires cloudbuild.builds.editor,
#                           already granted under RITM0214505).
#   --skip-secrets          Don't re-push secrets (saves ~5s; useful for
#                           code-only deploys).
#   --skip-build            Don't rebuild the image; redeploy the last tag.
#   --dry-run               Print commands, don't execute.
#   -h | --help             This help.
#
# PREREQ CHECKLIST (ran automatically):
#   □ gcloud CLI authenticated          (gcloud auth list)
#   □ docker daemon running             (docker info)
#   □ Artifact Registry API enabled     (gcloud services enable artifactregistry.googleapis.com)
#   □ Cloud Run API enabled             (gcloud services enable run.googleapis.com)
#   □ Secret Manager API enabled        (gcloud services enable secretmanager.googleapis.com)
#   □ .env contains all 6 required secrets
#
# EXIT CODES:
#   0  success — service deployed, healthz returned 200
#   1  bad args / missing tool
#   2  .env is missing or incomplete
#   3  gcloud not authenticated or project not accessible
#   4  docker build / push failed
#   5  gcloud run deploy failed
#   6  /healthz smoke-test failed post-deploy

set -euo pipefail

# ---------- 1. defaults + CLI parsing -------------------------------------

PROJECT_ID=""
REGION="europe-west3"
SERVICE="gen-pulse"
REPO="gen-pulse"
TAG=""
ENV_FILE="./.env"
INGRESS="all"
RUNTIME_SA=""
USE_LOCAL_DOCKER=0
SKIP_SECRETS=0
SKIP_BUILD=0
DRY_RUN=0

die() { echo "error: $*" >&2; exit "${2:-1}"; }
info() { echo "[gcp-deploy] $*"; }
run() {
  # Echo-and-run with dry-run support. Spaces in args are preserved by
  # using printf %q — essential for JQL strings with embedded quotes.
  local cmd=""
  for a in "$@"; do cmd="$cmd $(printf '%q' "$a")"; done
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "DRY-RUN:$cmd"
    return 0
  fi
  echo "+$cmd"
  "$@"
}

usage() {
  # Portable across BSD sed (macOS) and GNU sed (Linux). awk is the
  # common denominator — skip the shebang, strip "# " from each
  # subsequent comment line, stop at the first non-comment line.
  awk 'NR==1{next} /^[^#]/{exit} {sub(/^# ?/,""); print}' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id)   PROJECT_ID="${2:-}";   shift 2 ;;
    --region)       REGION="${2:-}";       shift 2 ;;
    --service)      SERVICE="${2:-}";      shift 2 ;;
    --repo)         REPO="${2:-}";         shift 2 ;;
    --tag)          TAG="${2:-}";          shift 2 ;;
    --env-file)     ENV_FILE="${2:-}";     shift 2 ;;
    --ingress)      INGRESS="${2:-}";      shift 2 ;;
    --runtime-sa)   RUNTIME_SA="${2:-}";   shift 2 ;;
    --use-local-docker) USE_LOCAL_DOCKER=1; shift ;;
    --skip-secrets) SKIP_SECRETS=1;        shift ;;
    --skip-build)   SKIP_BUILD=1;          shift ;;
    --dry-run)      DRY_RUN=1;             shift ;;
    -h|--help)      usage ;;
    *) die "unknown flag: $1 (try --help)" 1 ;;
  esac
done

# If --project-id wasn't passed, fall back to the project the gcloud CLI
# is already pointed at. This makes the happy-path invocation a single
# token — `scripts/gcp-deploy.sh` — once `gcloud config set project …`
# has been done once. Explicit --project-id still wins, useful for
# operators who maintain multiple GCP contexts.
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
  [[ -n "$PROJECT_ID" && "$PROJECT_ID" != "(unset)" ]] \
    || die "no --project-id passed and 'gcloud config get-value project' is unset. Run 'gcloud config set project <ID>' first (id is in the RITM0214505 approval email)." 1
  info "using project from 'gcloud config' — pass --project-id to override"
fi
[[ -f "$ENV_FILE" ]]   || die ".env not found at $ENV_FILE" 2
command -v gcloud  >/dev/null || die "gcloud CLI not installed" 1
if [[ $USE_LOCAL_DOCKER -eq 1 ]]; then
  command -v docker  >/dev/null || die "--use-local-docker set but docker is not installed" 1
  docker info >/dev/null 2>&1   || die "--use-local-docker set but docker daemon is not running (Rancher Desktop / Docker Desktop stopped?)" 1
fi

[[ -z "$TAG" ]] && TAG="$(date -u +%Y%m%d-%H%M%S)"
[[ -z "$RUNTIME_SA" ]] && RUNTIME_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"

# ---------- 2. project access sanity check --------------------------------

if ! gcloud projects describe "$PROJECT_ID" --format='value(projectId)' \
      >/dev/null 2>&1; then
  die "can't access project '$PROJECT_ID' — run 'gcloud auth login' first" 3
fi

info "project:      $PROJECT_ID"
info "region:       $REGION"
info "service:      $SERVICE"
info "repo:         $REPO"
info "tag:          $TAG"
info "ingress:      $INGRESS"
info "runtime SA:   $RUNTIME_SA"
info "env file:     $ENV_FILE"
if [[ $USE_LOCAL_DOCKER -eq 1 ]]; then
  info "builder:      local docker"
else
  info "builder:      Cloud Build (no local Docker required)"
fi
[[ $DRY_RUN -eq 1 ]] && info "mode:         DRY-RUN (no changes will be made)"
echo ""

# ---------- 3. required APIs ----------------------------------------------
# Cheap to re-run: enabling an already-enabled API is a no-op.

info "ensuring required APIs are enabled…"
run gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  cloudbuild.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

# ---------- 4. Artifact Registry repo -------------------------------------

REPO_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
IMAGE="${REPO_PATH}/${SERVICE}:${TAG}"
LATEST="${REPO_PATH}/${SERVICE}:latest"

info "ensuring Artifact Registry repo '$REPO' exists in $REGION…"
if ! gcloud artifacts repositories describe "$REPO" \
       --location="$REGION" --project="$PROJECT_ID" \
       >/dev/null 2>&1; then
  run gcloud artifacts repositories create "$REPO" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --repository-format=docker \
    --description="Gen Pulse container images (managed by scripts/gcp-deploy.sh)"
fi

# Configure docker to push to Artifact Registry via the gcloud auth
# helper — only needed if we're going to call `docker push` from the
# local machine. Cloud Build authenticates to Artifact Registry via
# its own service account, no ~/.docker/config.json rewrite needed.
if [[ $USE_LOCAL_DOCKER -eq 1 ]]; then
  info "configuring docker auth for ${REGION}-docker.pkg.dev…"
  run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
fi

# ---------- 5. runtime service account ------------------------------------
# Cloud Run runs as this SA. Scoped to exactly what the app needs:
#   - roles/secretmanager.secretAccessor  (read the 6 secrets)
#   - roles/logging.logWriter             (write structured logs)
# We explicitly DON'T grant run.invoker / anything else to this SA —
# Cloud Run's managed identity handles inbound auth separately.

SA_LOCAL="${SERVICE}-run"
info "ensuring runtime SA '$RUNTIME_SA' exists…"
if ! gcloud iam service-accounts describe "$RUNTIME_SA" \
       --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud iam service-accounts create "$SA_LOCAL" \
    --project="$PROJECT_ID" \
    --display-name="Gen Pulse Cloud Run runtime" \
    --description="Runs the Gen Pulse container; reads its own secrets."
fi

info "granting runtime SA access to Secret Manager + Logging…"
for role in \
    roles/secretmanager.secretAccessor \
    roles/logging.logWriter; do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# ---------- 6. push secrets -----------------------------------------------

if [[ $SKIP_SECRETS -eq 0 ]]; then
  info "pushing secrets from .env to Secret Manager…"
  secrets_args=( --project-id "$PROJECT_ID" --env-file "$ENV_FILE" )
  [[ $DRY_RUN -eq 1 ]] && secrets_args+=( --dry-run )
  run "$(dirname "$0")/gcp-secrets-push.sh" "${secrets_args[@]}"
else
  info "--skip-secrets set; assuming Secret Manager already holds current values"
fi

# ---------- 7. split .env → non-secret env-vars.yaml ----------------------

# Secrets we explicitly omit from env-vars (they come from Secret Manager):
SECRET_KEYS=(
  JIRA_TOKEN
  SLACK_BOT_TOKEN
  SLACK_SIGNING_SECRET
  OIDC_CLIENT_SECRET
  OIDC_SESSION_SECRET
  DASHBOARD_KEY
)

# Runtime-only overrides we force regardless of what's in .env:
#   - DATABASE_PATH is moved to /tmp (tmpfs on Cloud Run — writable,
#     ephemeral, matches the "stateless" storage choice).
#   - PORT is 8080 to match the Dockerfile / Cloud Run default.
#   - NODE_ENV is production.
#   - OIDC_REDIRECT_URI and PUBLIC_URL get set *after* the first deploy,
#     once the run.app URL is known. For now we inject placeholders the
#     server accepts so initial boot doesn't crash.
OVERRIDE_KEYS=(
  DATABASE_PATH
  PORT
  NODE_ENV
  # OIDC_REDIRECT_URI handled post-deploy
  # PUBLIC_URL handled post-deploy
)

TMPDIR_="$(mktemp -d -t gcp-deploy.XXXXXX)"
trap 'rm -rf "$TMPDIR_"' EXIT
ENV_YAML="${TMPDIR_}/env-vars.yaml"

# Build a YAML map. We emit `key: "value"` with each value JSON-escaped so
# embedded quotes / newlines in JQL strings survive unharmed. Uses
# python3 because writing a compliant YAML encoder in pure bash is a
# bottomless pit.
python3 - "$ENV_FILE" "$ENV_YAML" "${SECRET_KEYS[@]}" "--" "${OVERRIDE_KEYS[@]}" <<'PY'
import json, re, sys
env_path, yaml_path = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]
secrets, overrides = [], []
bucket = secrets
for x in rest:
    if x == "--":
        bucket = overrides
        continue
    bucket.append(x)

def parse_env(path):
    kv = {}
    with open(path, "r", encoding="utf-8") as f:
        for ln in f:
            if not ln.strip() or ln.lstrip().startswith("#"):
                continue
            m = re.match(r'^([A-Z][A-Z0-9_]*)=(.*)$', ln.rstrip("\n"))
            if not m: continue
            k, v = m.group(1), m.group(2)
            # Strip matching surrounding quotes (dotenv convention).
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                v = v[1:-1]
            kv[k] = v
    return kv

kv = parse_env(env_path)
# Drop secrets — Cloud Run gets those via --set-secrets.
for k in secrets:
    kv.pop(k, None)
# Drop override keys — we inject correct values below.
for k in overrides:
    kv.pop(k, None)

# Forced overrides for the Cloud Run runtime. Keep this list in sync
# with OVERRIDE_KEYS above so the split logic above strips them first.
kv["DATABASE_PATH"] = "/tmp/teampresence.db"
kv["PORT"] = "8080"
kv["NODE_ENV"] = "production"

# Workday: on Cloud Run the data/workday-absences.csv file isn't in
# the image (excluded by .dockerignore — it contains PII). Until we
# wire GCS or a Workday REST endpoint, disable the provider so the
# server boots cleanly and Team Presence still shows Slack status
# for everyone. Operators can override this by setting
# WORKDAY_PROVIDER in .env to a non-"none" value BEFORE running the
# deploy — the override below only applies when .env says WORKDAY
# is still pointed at the local CSV path (the demo default).
if kv.get("WORKDAY_PROVIDER", "").lower() in ("", "csv"):
    kv["WORKDAY_PROVIDER"] = "none"
    # Clear the CSV path so nothing tries to read it.
    kv.pop("WORKDAY_CSV_PATH", None)

# Cloud Run's --env-vars-file wants flow-safe YAML. Emit as a simple
# mapping, one key per line, with each value wrapped in double quotes
# and JSON-escaped so control characters / quotes survive.
# ensure_ascii=False keeps Czech names (Žabenský, Šimková) as raw
# UTF-8 instead of "\u017dabensk\u00fd" — both are valid YAML, raw
# is legible to the humans who will inevitably grep this file.
with open(yaml_path, "w", encoding="utf-8") as f:
    for k in sorted(kv):
        # json.dumps gives us a valid YAML double-quoted string for free.
        f.write(f"{k}: {json.dumps(kv[k], ensure_ascii=False)}\n")

print(f"wrote {len(kv)} non-secret env vars to {yaml_path}")
PY

info "env-vars file:    $ENV_YAML"

# ---------- 8. build + push image -----------------------------------------
#
# Two paths — Cloud Build (default) or local Docker. Both end with the
# same image pushed to Artifact Registry under $IMAGE + $LATEST.

if [[ $SKIP_BUILD -eq 1 ]]; then
  info "--skip-build set; reusing $LATEST from last push"
  IMAGE="$LATEST"
elif [[ $USE_LOCAL_DOCKER -eq 1 ]]; then
  info "building Docker image $IMAGE locally…"
  # --platform=linux/amd64 is forced because Cloud Run runs on amd64 and
  # Mac developers on Apple Silicon would otherwise push an arm64 image
  # that Cloud Run silently fails to start.
  run docker build --platform=linux/amd64 -t "$IMAGE" -t "$LATEST" .
  info "pushing image…"
  run docker push "$IMAGE"
  run docker push "$LATEST"
else
  # Cloud Build path — tarballs the working tree (respecting
  # .dockerignore and .gcloudignore), uploads to a staging GCS
  # bucket in $PROJECT_ID, and runs `docker build` on Google's
  # infrastructure. Output image goes straight to Artifact Registry.
  #
  # Why `--tag` not `--config`: we don't need the fancier multi-step
  # cloudbuild.yaml pipeline — a single-image build matches exactly
  # what `docker build -t $IMAGE` would produce. Simpler surface
  # area, fewer failure modes, one YAML file we don't have to
  # maintain.
  #
  # `--machine-type=e2-highcpu-8` cuts our build time roughly in half
  # for the compile-heavy `npm ci` step (better-sqlite3 needs g++).
  # Default is e2-medium which is genuinely slow here.
  info "building $IMAGE via Cloud Build (no local Docker needed)…"
  run gcloud builds submit \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --tag="$IMAGE" \
    --machine-type=e2-highcpu-8 \
    --timeout=20m \
    --quiet \
    .
  # Tag the just-built image as :latest too, so --skip-build
  # redeploys are trivially one-command. gcloud doesn't emit two
  # tags in one submit, so we `tags add` in a second call — cheap,
  # metadata-only.
  run gcloud artifacts docker tags add "$IMAGE" "$LATEST" \
    --project="$PROJECT_ID" --quiet
fi

# ---------- 9. deploy Cloud Run revision ----------------------------------

info "deploying $SERVICE to Cloud Run ($REGION)…"
deploy_args=(
  run deploy "$SERVICE"
  --project="$PROJECT_ID"
  --region="$REGION"
  --image="$IMAGE"
  --service-account="$RUNTIME_SA"
  --ingress="$INGRESS"
  --allow-unauthenticated            # In-app Azure AD OIDC gates every request (RITM0213874).
  --port=8080
  --cpu=1
  --memory=512Mi
  --concurrency=40
  --timeout=60s
  --min-instances=0
  --max-instances=2
  --env-vars-file="$ENV_YAML"
  --set-secrets="JIRA_TOKEN=gen-pulse-jira-token:latest,SLACK_BOT_TOKEN=gen-pulse-slack-bot-token:latest,SLACK_SIGNING_SECRET=gen-pulse-slack-signing-secret:latest,OIDC_CLIENT_SECRET=gen-pulse-oidc-client-secret:latest,OIDC_SESSION_SECRET=gen-pulse-oidc-session-secret:latest,DASHBOARD_KEY=gen-pulse-dashboard-key:latest"
  --labels=app=gen-pulse,managed-by=gcp-deploy-sh
  --quiet
)
run gcloud "${deploy_args[@]}"

# ---------- 10. post-deploy: pin OIDC_REDIRECT_URI + PUBLIC_URL ----------
# The service URL is only known *after* the first `run deploy`, so we
# fetch it and patch the revision in a second call. Subsequent deploys
# are no-op for this (URL is stable once the service exists).

if [[ $DRY_RUN -eq 0 ]]; then
  URL="$(gcloud run services describe "$SERVICE" \
           --project="$PROJECT_ID" --region="$REGION" \
           --format='value(status.url)')"
  info "service URL: $URL"

  info "pinning OIDC_REDIRECT_URI + PUBLIC_URL to service URL…"
  run gcloud run services update "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --update-env-vars="OIDC_REDIRECT_URI=${URL}/auth/callback,PUBLIC_URL=${URL}" \
    --quiet

  # ---------- 11. smoke-test /healthz -----------------------------------

  info "smoke-testing ${URL}/healthz …"
  if curl --fail --silent --show-error --max-time 15 \
       "${URL}/healthz" >/dev/null; then
    info "/healthz returned 200 ✓"
  else
    die "/healthz failed — check 'gcloud run services logs tail $SERVICE --region=$REGION'" 6
  fi

  echo ""
  info "DONE."
  info "next step: update Azure AD app (RITM0213874) redirect URI to:"
  info "           ${URL}/auth/callback"
else
  info "dry-run complete; nothing was deployed"
fi
