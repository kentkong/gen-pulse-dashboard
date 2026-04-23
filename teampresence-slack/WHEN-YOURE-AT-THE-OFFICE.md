# When you're at the office — master checklist

Single page, start-to-finish, of exactly what to do after your break. Everything below is prepped — no code left to write, just messages to send and values to paste.

Suggested order is top-down. Everything is independent though, so if one blocker stalls, just skip to the next.

---

## 0. Make sure the dashboard is still running (30 seconds)

```bash
# From anywhere:
curl -s http://localhost:3000/healthz && echo " — dashboard is up"
```

If that prints `ok — dashboard is up`, skip to step 1. If not:

```bash
cd ~/Documents/test/teampresence-slack
pkill -9 -f 'node src/index.js' 2>/dev/null
PORT=3000 node src/index.js &
sleep 3
tail -n 20 /tmp/gen-pulse.log 2>/dev/null || echo "(no log file — running inline)"
```

Expected log lines:

```
[jira] multi-project: EMOPS, EMAILCO, all (default=EMOPS)
[presence] Workday provider: csv
Gen Pulse running on http://localhost:3000
  mode: WEB-ONLY
```

---

## 1. Mobile demo URL is still live? (1 minute)

Your Cloudflare tunnel URL from yesterday might still be up.

```bash
# See if any cloudflared processes are running:
ps aux | grep -i cloudflared | grep -v grep
```

If yes, use the old URL. If no:

```bash
cloudflared tunnel --url http://localhost:3000 &
sleep 6
# The public URL will appear in the output.
```

Copy the new `https://*.trycloudflare.com/?key=<your DASHBOARD_KEY>` URL. Text it to yourself, test on phone, confirm SSO and Jira widgets load.

---

## 2. Send the 3 admin emails (15 min total)

Three nearly-identical "forward this email" asks, one per integration that needs a human at Gen to do something. **Each of these is pre-drafted — you only fill in the recipient name + send.**

| Email | Recipient | Doc | What they send you back |
| ----- | --------- | --- | ----------------------- |
| **Slack admin** | Your Slack workspace admin | `SLACK-ADMIN-REQUEST.md` | Bot token, signing secret |
| **Azure AD / identity admin** | Whoever owns Entra ID app registrations at Gen | `AZURE-AD-ADMIN-REQUEST.md` | Tenant ID, client ID, client secret, 4 group GUIDs |
| **Scrum master / email eng lead** | Your team's scrum master | `SCRUM-MASTER-REQUEST.md` | Signed-off JQL per widget |
| **HR / People Ops** | Whoever owns Workday at Gen | `HR-WORKDAY-REQUEST.md` | CSV or iCal feed of team PTO |

For each: open the doc, copy the email-template block (they all start with "**Email template — forward to ...**"), paste into your email client, fill in the bracketed fields (`[name]`, `[distro]`, etc.), send.

Total time: ~15 min for all four. Everything is write-and-forget once sent — they each have separate "when the response arrives, do this" playbooks (in the same docs) that you can execute independently whenever each reply lands.

---

## 3. Want to show your manager the Azure AD login flow working locally? (10 min)

The SSO code is fully shipped and feature-flagged. If you want to demo the login screen **before** Azure AD gives you real credentials, there's no way to do that — Azure won't issue a token against a fake tenant. So you have two paths:

**Path A — wait for the identity admin.** When they send back the three values:

```bash
cd ~/Documents/test/teampresence-slack
./scripts/set-oidc-credentials.sh
# ... paste tenant id, client id, client secret
```

Then edit `.env` and add the 4 `OIDC_ROLE_MAP_*` lines from the four group GUIDs they sent. Restart:

```bash
pkill -9 -f 'node src/index.js'
PORT=3000 node src/index.js &
sleep 3
curl -s http://localhost:3000/auth/status | python3 -m json.tool
```

Expect `"strategy": "oidc", "enabled": true`. Open http://localhost:3000/ → you'll see a "Sign in with Microsoft" pill top-right. Click it, sign in with your Gen Digital account, land back on the dashboard with your real name + role.

**Path B — show the UI without the flow working.** You can preview what the sign-in button looks like without any Azure config by setting `AUTH_STRATEGY=oidc` with garbage values:

```bash
# DO NOT commit this — it's a UI-only demo trick.
cat >> .env <<'EOF'
AUTH_STRATEGY=oidc
OIDC_TENANT_ID=00000000-0000-0000-0000-000000000000
OIDC_CLIENT_ID=00000000-0000-0000-0000-000000000000
OIDC_CLIENT_SECRET=placeholder
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
OIDC_SESSION_SECRET=00000000000000000000000000000000
EOF
```

(Azure discovery will fail at boot, server logs a warning, falls back to shared-key. But `/api/me` still reports `signedIn: false, loginUrl: "/auth/login"` so the **Sign in with Microsoft** button shows up in the UI.) Remove those 6 lines again before showing real data.

Recommendation: skip Path B unless your manager specifically wants to see the button. The "show them the login button" demo is low-signal compared to "here's the live Jira/Workday data we shipped."

---

## 4. Commit + push today's work (2 min)

Already staged for you. Just run:

```bash
cd ~/Documents/test/teampresence-slack

# Review:
git status
git diff --stat

# Commit with a meaningful message:
GIT_AUTHOR_NAME="Kevin Mold" GIT_AUTHOR_EMAIL="kevin.mold@gendigital.com" \
GIT_COMMITTER_NAME="Kevin Mold" GIT_COMMITTER_EMAIL="kevin.mold@gendigital.com" \
  git commit -am "$(cat <<'EOF'
Azure AD SSO scaffold + go-live handoff packets

- Real OIDC authenticator wired against openid-client v6 (PKCE + JWKS)
- /auth/login, /auth/callback, /auth/logout, /auth/status routes
- Signed session cookies (HS256), role mapping from Azure AD groups
- 'Sign in with Microsoft' pill on the dashboard when OIDC is configured
- Feature-flagged: AUTH_STRATEGY=oidc activates it, shared-key stays default
- OIDC_ALLOW_SHARED_KEY_FALLBACK=true keeps curl/slack callers working
- New scripts/set-oidc-credentials.sh for secure credential input
- Handoff email packets: AZURE-AD-ADMIN-REQUEST.md, SCRUM-MASTER-REQUEST.md,
  HR-WORKDAY-REQUEST.md, and a master WHEN-YOURE-AT-THE-OFFICE.md checklist
- JQL-WORKBOOK.md now opens with the current live defaults snapshot
EOF
)"

git push
```

If the push fails with an SSL error, you need `GIT_SSL_CAINFO` set (it's already in `~/.zshrc` but a stale terminal may not have picked it up):

```bash
export GIT_SSL_CAINFO="$HOME/.certs/corporate-bundle.pem"
git push
```

---

## 5. Sanity-check the status of every integration (3 min)

Once everything's pushed, run this one-liner to see the state of every integration at a glance:

```bash
cd ~/Documents/test/teampresence-slack
KEY=$(awk -F= '/^DASHBOARD_KEY=/{print $2}' .env)
echo "=== /auth/status ==="
curl -s http://localhost:3000/auth/status | python3 -m json.tool
echo ""
echo "=== /api/me ==="
curl -s "http://localhost:3000/api/me?key=$KEY" | python3 -m json.tool
echo ""
echo "=== /api/jira-projects ==="
curl -s "http://localhost:3000/api/jira-projects?key=$KEY" | python3 -m json.tool
echo ""
echo "=== /api/absences (next 14d) ==="
curl -s "http://localhost:3000/api/absences?key=$KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"absences\",[]))} absences in feed')"
echo ""
echo "=== all 10 widgets / EMOPS / EMAILCO / all ==="
for w in weekly-throughput backlog-overview top-priority-tickets inflow-vs-resolved \
         ticket-lifecycle kanban-board sla-aging-risk sprint-backlog reopen-rate \
         throughput-leaderboard; do
  for p in EMOPS EMAILCO all; do
    printf '%-28s %-8s ' "$w" "$p"
    curl -s "http://localhost:3000/api/widgets/$w?project=$p&key=$KEY" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if "error" not in d else "ERR: "+str(d.get("error"))[:80])'
  done
done
```

Expected: 30 `ok` lines (10 widgets × 3 projects), a non-empty absences feed, `/auth/status` reports `shared-key` until Azure is wired, `/api/me` reports the Slack-derived identity for your key.

Any `ERR:` → check the server log, usually an `.env` typo.

---

## When each external response arrives

| Response | Apply script / doc |
| -------- | ------------------ |
| Slack tokens from workspace admin | `./scripts/set-slack-tokens.sh`, then restart |
| Azure AD credentials from identity team | `./scripts/set-oidc-credentials.sh`, add `OIDC_ROLE_MAP_*`, restart |
| Scrum master's signed-off JQL | Edit `.env` widget-by-widget, restart, verify via step 5 above |
| HR's PTO CSV | Save as `data/workday-absences.csv`, dashboard picks it up in ≤5 min |
| HR's iCal URL | Add `WORKDAY_PROVIDER=ical` + `WORKDAY_ICAL_URL=...` to `.env`, restart |

Each of those has a "when reply arrives" playbook in its own doc. You never need to hold all of this in your head.

---

## What's NOT going to happen today

- **Going live on a corporate hostname** — needs DNS from IT, not in scope for today
- **GitHub integration** — explicitly deferred per your last plan
- **Role-gated UI** (manager-only widgets, etc.) — parked until Azure AD is live and claim shape is confirmed
- **Moving off the `DASHBOARD_KEY`** — keep it alongside OIDC during rollout with `OIDC_ALLOW_SHARED_KEY_FALLBACK=true`

---

## If you want to show the senior manager mid-day, here's the 60-second pitch

"Since yesterday's review, I've shipped three hardening wedges. One — every Jira widget is now running live against real EMOPS and EMAILCO data with the right priority filters; the scrum master has a two-page doc to sign off JQL changes. Two — Workday integration is wired: the dashboard reads a 7-column CSV (or iCal feed if HR prefers) and shows real vacations on the team grid. Three — Azure AD SSO is fully scaffolded; the identity team just needs to create an app registration and hand me three values. Everything's behind feature flags so nothing in the demo can break while I wait for admins. Three hand-off emails are ready to send. Want to see the phone version?"
