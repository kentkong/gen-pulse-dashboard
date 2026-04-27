#!/usr/bin/env bash
# ============================================================================
# demo-warmup.sh
# ----------------------------------------------------------------------------
# Hits every dashboard widget endpoint with `?force=1` so its cache is
# fully populated BEFORE the demo starts. Without this, the first
# viewer (you, on screen-share) waits 5–15s on cold-cache Jira queries
# while Alan watches a spinner. With it, every widget paints instantly
# on first load.
#
# Discovers widgets dynamically from /api/widgets, so it stays correct
# as new widgets are added.
#
# USAGE
#   ./scripts/demo-warmup.sh                          # warm 'all' project
#   ./scripts/demo-warmup.sh EMOPS EMAILCO all        # warm specific projects
#   PORT=3000 ./scripts/demo-warmup.sh
#
# Idempotent — safe to run repeatedly (e.g. once at +5min, again at +1min).
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

PORT="${PORT:-3000}"
HOST="http://localhost:${PORT}"
KEY=$(awk -F= '/^DASHBOARD_KEY=/{v=$2; gsub(/"/,"",v); print v}' .env 2>/dev/null)
if [[ -z "$KEY" ]]; then
  echo "demo-warmup: DASHBOARD_KEY not set in .env — aborting." >&2
  exit 1
fi

# Default to the projects defined in .env (JIRA_PROJECT_KEYS) so we
# warm everything the operator might switch to mid-demo, not just the
# default project.
if [[ "$#" -gt 0 ]]; then
  PROJECTS=("$@")
else
  KEYS_RAW=$(awk -F= '/^JIRA_PROJECT_KEYS=/{v=$2; gsub(/"/,"",v); print v}' .env 2>/dev/null)
  if [[ -n "$KEYS_RAW" ]]; then
    IFS=',' read -ra PROJECTS <<< "$KEYS_RAW"
    PROJECTS+=("all")
  else
    PROJECTS=("all")
  fi
fi

GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
note() { printf "${BOLD}[warmup]${RESET} %s\n" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s ${DIM}%s${RESET}\n" "$1" "$2"; }
fail() { printf "  ${RED}✗${RESET} %s ${DIM}%s${RESET}\n" "$1" "$2"; }

# 1. Discover widgets ------------------------------------------------------
note "discovering widgets via $HOST/api/widgets"
WIDGETS_JSON=$(curl -sS -m 8 "$HOST/api/widgets?key=$KEY")
if [[ -z "$WIDGETS_JSON" ]] || ! echo "$WIDGETS_JSON" | python3 -c 'import sys,json; json.load(sys.stdin)' >/dev/null 2>&1; then
  echo "demo-warmup: cannot reach $HOST/api/widgets — is the server up? (./scripts/demo-status.sh)" >&2
  exit 1
fi

# Pull `<id>\t<dataEndpoint>\t<projectScoped>` per widget. We hit
# whatever endpoint the widget metadata declares — most widgets use
# /api/widgets/<id>, but a few (e.g. team-presence) point elsewhere.
# `projectScoped` flags whether the endpoint accepts ?project=… so
# we don't append a stray query param to /api/team.
WIDGET_LINES=$(echo "$WIDGETS_JSON" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for w in d.get("widgets",[]):
    wid=w.get("id"); ep=w.get("dataEndpoint")
    if not wid or not ep: continue
    # /api/widgets/<id> is project-scoped by convention; /api/team
    # and any future bespoke endpoints are not.
    project_scoped = "1" if ep.startswith("/api/widgets/") else "0"
    print("\t".join([wid, ep, project_scoped]))
')

count=$(printf "%s\n" "$WIDGET_LINES" | grep -c .)
note "found $count widgets · projects: ${PROJECTS[*]}"

# 2. Warm each (project × widget) cell ------------------------------------
# project-unscoped endpoints (e.g. /api/team) only need to be hit
# once total, not once per project. Tracked via a delimited string
# (associative arrays would be cleaner but require bash 4+, and
# macOS ships bash 3.2 by default).
TOTAL=0; OK=0; BAD=0
WARMED_UNSCOPED=":"
START=$(date +%s)
for project in "${PROJECTS[@]}"; do
  printf "\n${BOLD}project=%s${RESET}\n" "$project"
  while IFS=$'\t' read -r wid ep scoped; do
    [[ -z "$wid" ]] && continue
    if [[ "$scoped" == "1" ]]; then
      url="$HOST${ep}?project=$project&force=1&key=$KEY"
    else
      # Non-project endpoint: skip after first warm so we don't
      # waste 3× the time hitting /api/team for nothing.
      if [[ "$WARMED_UNSCOPED" == *":${wid}:"* ]]; then
        printf "  ${DIM}·${RESET} %s ${DIM}(unscoped — already warmed)${RESET}\n" "$wid"
        continue
      fi
      url="$HOST${ep}?key=$KEY"
      WARMED_UNSCOPED="${WARMED_UNSCOPED}${wid}:"
    fi
    TOTAL=$((TOTAL + 1))
    rc_and_time=$(curl -sS -o /dev/null -w "%{http_code} %{time_total}" -m 30 "$url" 2>/dev/null)
    rc="${rc_and_time%% *}"; t="${rc_and_time#* }"
    if [[ "$rc" == "200" ]]; then
      OK=$((OK + 1))
      ok "$wid" "${t}s"
    else
      BAD=$((BAD + 1))
      fail "$wid" "HTTP $rc · $url"
    fi
  done <<< "$WIDGET_LINES"
done

ELAPSED=$(( $(date +%s) - START ))
printf "\n${BOLD}warmup complete${RESET}  ${DIM}%ds total · %d ok · %d failed${RESET}\n" "$ELAPSED" "$OK" "$BAD"
[[ "$BAD" == "0" ]]
