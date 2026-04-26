# Gen Pulse — Go-Live Runbook

Turning the dashboard from demo-grade into production. Work the steps top-to-bottom; each step is independent (you can ship Jira first, then Workday, then Slack), but this order is the fastest path from where you are today.

Legend:
- **[you]**    — you, Kevin.
- **[ops]**    — whoever owns `.env` on the production box.
- **[csm]**    — a CSM lead who knows what the JQL filters should be.
- **[it]**     — Gen Digital IT / collab-tools / Slack admin.
- **[hr]**     — whoever owns the Workday absence export.
- **[sec]**    — Security / DPO.

Each step includes an explicit **success test** so you know the moment you're green.

---

## Step 0 — First boot, offline

**Who:** [you]
**Prereq:** `node >= 20`, `npm`.

1. `cd teampresence-slack`
2. `cp .env.example .env`
3. `npm install`
4. `npm start`

**Expected:** The server prints the `WEB-ONLY MODE` banner (no Slack creds yet), then:
```
EMAIL NORTON Gen Pulse running on http://localhost:3000
  mode: WEB-ONLY
  tz:   Europe/Prague
  open: http://localhost:3000/?key=<set DASHBOARD_KEY in .env>
```

Set `DASHBOARD_KEY=anything-random` in `.env`, restart, then open the URL it prints.
✅ **Success test:** dashboard loads, all widgets render with **demo** pills — no red errors.

---

## Step 1 — Jira (highest priority)

### 1a. Get a Personal Access Token [you]

1. Visit `https://<your-jira>/plugins/servlet/de.resolution.apitokenauth/admin` *(server/DC)* or Atlassian profile → **Security → API tokens** *(cloud)*.
2. Create a token scoped "read-only, Jira projects EMOPS + EMAILCO". Give it 90 days.
3. **Never paste it in chat/email.**

### 1b. Store the token safely [you]

```bash
./scripts/set-jira-token.sh
```
Prompts privately, writes `JIRA_BASE_URL` + `JIRA_TOKEN` to `.env`.

### 1c. Smoke-test connectivity [you]

```bash
curl -sS -H "Authorization: Bearer $(grep '^JIRA_TOKEN=' .env | cut -d= -f2-)" \
  "$(grep '^JIRA_BASE_URL=' .env | cut -d= -f2-)/rest/api/2/myself" | head -c 500
```
✅ **Success test:** you see JSON with your `name`, `emailAddress`, `key`. Anything else (HTML, 401, 403) means the token or base URL is wrong.

### 1d. Agree on the 10 JQL queries [csm + you]

Work through `JQL-WORKBOOK.md` with your CSM lead. Pin down both the **EMOPS** and **EMAILCO** JQL for every widget.

### 1e. Put the JQL into `.env` [ops]

Copy the final JQL into the relevant `JIRA_<PROJECT>_<WIDGET>_JQL=` lines. Restart the server.

✅ **Success test:**
- Each widget's **demo** pill disappears.
- Opening a widget's filter drawer (tap the info icon) shows: JQL, row count, last-fetched-at, and "source = live Jira".
- Numbers roughly match what the CSM team expects for "today".

**If a widget shows a red error chip:** open its drawer — the exact HTTP error from Jira is surfaced there. Common causes:
- `400 Bad Request` — JQL has a typo.
- `401 Unauthorized` — PAT expired or wrong base URL.
- `403 Forbidden` — PAT doesn't have "Browse Projects" permission on that project.

---

## Step 2 — Workday absences

### 2a. Decide the provider [you + it]

- **csv** (recommended for pilot) — one CSV file on disk, re-read every 5 min. Zero IT coordination needed.
- **ical** — shared iCal URL (Workday / Outlook / Gcal). Needs ATTENDEE email matching.
- **rest** — JSON endpoint. Requires IT to expose the Workday RaaS endpoint.

### 2b. CSV path (quickest — ships same day) [hr → you]

1. Send `data/workday-absences.template.csv` to HR. Ask them to fill in real PTO dates for the 8 roster members.
2. When they return the file, save it to `data/workday-absences.csv`.
3. Add to `.env`:
   ```
   PRESENCE_MODEL=slack+workday
   WORKDAY_PROVIDER=csv
   WORKDAY_CSV_PATH=./data/workday-absences.csv
   ```
4. No restart needed — the CSV is re-read every 5 min.

✅ **Success test:** the "Out today" and "Out next 7 days" sections reflect the dates in the file. Tap the Presence health chip — it should say "workday: ok, rows: N".

### 2c. iCal path (best when Workday exposes a shared calendar) [it]

Ask IT for a read-only iCal URL for the team's leave calendar. Then:
```
WORKDAY_PROVIDER=ical
WORKDAY_ICAL_URL=https://your-workday-host/calendars/team-email-norton.ics
```

### 2d. REST path (production) [it]

Covered in `WORKDAY.md`.

---

## Step 3 — Slack integration

### 3a. File the admin request [you → it]

Forward `SLACK-ADMIN-REQUEST.md` to your Slack workspace admin. Expected turnaround: 1–5 business days.

**In flight (as of 2026-04-26 PM):**

| Item | Status | Reference |
| --- | --- | --- |
| ServiceNow Slack-app workspace-install ticket | ✅ **APPROVED 2026-04-26** — Petr Šilhan (owner) + Rob Ryan (admin, ref `MSG7711702_TRc8EWEzUeCNfXTb9Psu`) | **RITM0213806** |
| Gen Pulse app created on api.slack.com (Gen workspace) | ✅ 2026-04-24 — App ID `A0AUY7JRG5T` | `SLACK-ADMIN-REQUEST.md` |
| `svc.slack.appadm` added as collaborator on the app | ✅ 2026-04-24 | api.slack.com → Gen Pulse → Collaborators |
| App ID + collaborator confirmation sent to admin | ✅ 2026-04-24 | RITM0213806 thread |
| Bot scopes configured on the app (`users:read`, `users.profile:read`) | ✅ 2026-04-24 — two scopes (modern v2 apps bundle presence into `users:read`) | api.slack.com → Gen Pulse → OAuth & Permissions |
| Install request submitted to the Gen workspace | ✅ 2026-04-24 — second attempt succeeded after admin enabled install requests | api.slack.com → Gen Pulse → Install App |
| Install request approved by workspace admin | ✅ 2026-04-26 — both Petr and Rob signed off | RITM0213806 thread |
| **Retrieve `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` from api.slack.com** | **⏳ Kevin's next action — unblocks Team Presence** | Step 3b below |
| `.env` populated + `data/slack-overrides.json` generated + `PRESENCE_MODEL=slack+workday` flipped | Blocked on token retrieval | `./scripts/activate-slack.sh` |

### 3b. One-shot activator — the fast path [you]

Once the admin hands over tokens, **run this single command** and you're done:
```
./scripts/activate-slack.sh
```
It will prompt (hidden input) for `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `SLACK_APP_TOKEN` (optional), then in one pass:
1. Hit `auth.test` to verify the bot token works **before touching anything**.
2. Back up `.env` to `.env.<timestamp>.bak`.
3. Write all three tokens + flip `PRESENCE_MODEL=slack+workday` in `.env`.
4. Call `scripts/map-slack-users.mjs --write` — fetches `users.list`, matches by name against the roster in `src/team.js`, writes the slug → Slack-ID mapping to `data/slack-overrides.json` (gitignored).
5. Restart the server on :3000 and smoke-test `/api/team`.

Non-interactive form (for CI or scripted runs):
```
./scripts/activate-slack.sh --yes \
  --bot-token xoxb-... \
  --signing-secret ... \
  --app-token xapp-...          # optional
```

Dry-run first if you want to eyeball the proposed mapping without touching anything:
```
./scripts/activate-slack.sh --dry-run --bot-token xoxb-...
```

Exit codes: `0` ok, `1` bad args, `2` `auth.test` failed (wrong/revoked token), `3` 0 roster matches (wrong workspace), `4` server didn't come up on :3000.

### 3c. If you ever want to do it by hand (skip 3b) [you]

Put the three values into `.env`:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...         # optional, Socket Mode
PRESENCE_MODEL=slack+workday
```
And populate `data/slack-overrides.json` with slug → Slack IDs:
```json
{ "jan-bartoncik": ["U0123..."], "iryna-botulinska": ["U0456..."], ... }
```
You can generate the right shape with:
```
node scripts/map-slack-users.mjs --write     # needs $SLACK_BOT_TOKEN in env
```
Restart the server.

✅ **Success test:**
- Server starts in `FULL (Slack connected)` mode (banner disappears, no placeholder warnings).
- Team Presence widget shows live auto-presence dots (green / away) that match each person's actual Slack state.
- Setting your own Slack status to "🏖️ On vacation" visibly flips your Gen Pulse card to "Vacation" within ~60 seconds.

---

## Step 4 — Production hosting & SSO

### 4a. Pick a hosting target [you + it]

Options, from simplest to most robust:
- **Azure App Service** — matches the rest of Gen Digital's stack, has built-in SSO integration.
- **AWS App Runner / ECS** — if the team already owns AWS for this workload.
- **On-prem Docker host** — fastest if a machine already exists.

### 4b. Set a stable URL [it]

E.g. `https://gen-pulse.corp.gendigital.net`. Put it in `.env`:
```
PUBLIC_URL=https://gen-pulse.corp.gendigital.net
```

### 4c. Stand up SSO [it + you]

Swap the current `DASHBOARD_KEY` gate for Azure AD SSO. See `USER-ACCOUNT-PLAN.md` for the concrete design and `AZURE-AD-ADMIN-REQUEST.md` for the app-registration spec that was sent to the identity team.

**In flight (as of 2026-04-26 PM):**

| Item | Status | Reference |
| --- | --- | --- |
| MyApps / ServiceNow app-registration ticket | **⚠️ CMDB done — Identity-team handoff needs verification** (see below) | **RITM0213874** |
| CMDB validation intake (from Jaanvi, CMDB team) | ✅ Complete 2026-04-26 — *"Application created in CMDB as requested. No further action required from CMDB team. Closing the ticket."* | RITM0213874 thread |
| **Verify whether RITM0213874 is fully closed or still open to Identity** | **⏳ Kevin's next action** — open ticket in ServiceNow; see `AZURE-AD-ADMIN-REQUEST.md` status banner for the decision tree | ServiceNow |
| Senior manager + director sign-off to proceed | Pending — always was a separate gate; email still needs to go out | — |
| OIDC_* credentials populated in `.env` | Blocked on Identity-team execution + sign-off | `./scripts/set-oidc-credentials.sh` |
| Four security-group Object IDs for role mapping | Blocked on above | `OIDC_ROLE_MAP_*` env vars |
| First successful `/auth/login` round-trip | Blocked on above | `curl -s $PUBLIC_URL/auth/status` |

When **RITM0213874** resolves, follow the 3-step activation path documented in `AZURE-AD-ADMIN-REQUEST.md` → "When the credentials arrive — 3-step activation". Do not paste credentials anywhere except through `./scripts/set-oidc-credentials.sh`.

---

### 4d. Interim demo URL — ephemeral Cloudflare quick-tunnel [you]

Until Step 4a–4c land, you need a public URL to drive the demo (and let a small pilot group preview on their phones). The repo ships a supervised quick-tunnel for exactly this.

**One-shot start:**

```bash
cd teampresence-slack
npm run demo
```

This boots three things in order:

1. `node src/index.js` — the dashboard (PORT=3000 by default).
2. `scripts/tunnel-watchdog.sh` — supervises `cloudflared tunnel --url http://localhost:3000`, auto-restarts on network drops, writes the announced public URL to `data/tunnel-state.json`.
3. A polling loop that waits for the tunnel URL, prints it plus the read-only team URL (with `?key=…` appended if `DASHBOARD_KEY` is set), then tails both log files.

Ctrl+C tears both children down cleanly and wipes the state file so the UI stops advertising a dead URL.

**Surface the URL in the dashboard itself:**

Click the share-link icon in the topnav (three circles with connecting lines, between Search and Notifications). The popover shows:

- Current public URL + a Copy button
- Team read-only URL (public URL + `?key=…`) + a Copy button
- Live tunnel status (green = up with uptime counter, amber = down with reason)

The status dot on the topnav icon also tracks the tunnel so you can tell at a glance whether the link is live.

**Known limitations — be honest with the audience:**

- The URL rotates on every tunnel restart. Open the share popover again after a restart and re-paste.
- Ephemeral `*.trycloudflare.com` URLs are **not acceptable as an Azure AD redirect URI**, so real-SSO testing has to wait for Step 4a–4c. Demo-mode SSO (`AUTH_STRATEGY=mock-oidc`) works over the tunnel just fine.
- Don't post the URL publicly. The 8-person pilot is the target audience.

**Run just the tunnel (if the server is already running elsewhere):**

```bash
npm run tunnel
```

**Logs:** `data/logs/server.log`, `data/logs/tunnel.log` (both gitignored).

**Troubleshooting:**

| Symptom | Check | Fix |
| --- | --- | --- |
| Popover says "No tunnel running" but `demo-start.sh` is in the foreground | `data/logs/tunnel.log` | Usually Cloudflare rate-limit or corp proxy. Watchdog will retry with backoff; give it 30–60s. |
| Popover says "up" but URL 404s | tail `tunnel.log` for the announced URL; compare with popover | Re-open popover (it re-fetches `/api/demo-url`). The watchdog may have just rotated. |
| `cloudflared: command not found` | `~/bin/cloudflared` present? | Install: `brew install cloudflared` or `curl -L ...` — see Cloudflare docs. |

---

## Step 5 — Pre-prod checks

- [ ] Privacy / DPO sign-off obtained (see SLACK-ADMIN-REQUEST for framing).
- [ ] `.env` committed to secret store (Azure Key Vault / AWS Secrets Manager — NEVER git).
- [ ] Service health endpoint (`/healthz`) wired to uptime monitoring.
- [ ] Runbook handed to whoever is on-call for CSM tooling.

---

## Step 6 — Launch to the pilot team

1. Send the URL to the 8 EMAIL NORTON teammates.
2. Ask each person to set a meaningful Slack status (🏖️ / 📞 in a meeting / 🏠 WFH) so the widget is immediately useful.
3. Schedule a 2-week feedback retro.

---

## Appendix A — "Something's broken" quick triage

| Symptom | Look at | Likely fix |
| ------- | ------- | ---------- |
| `ERR_CONNECTION_REFUSED` on `:3000` | server console | Server crashed on boot. Read the new `[FATAL]` block — it names the exact cause. |
| All widgets show **demo** pills | any filter drawer | JQL env vars are still commented out. Back to Step 1e. |
| One widget shows a red **error** chip | that widget's drawer | Exact Jira HTTP error + the JQL that was sent. Fix the JQL or the permission. |
| Team Presence shows everyone as "Unknown" | server logs | Slack scopes not approved yet, or `PRESENCE_MODEL` still `bot`. Back to Step 3. |
| "Out today" / "Out next 7 days" empty | Presence health chip | `WORKDAY_PROVIDER=none` or CSV path wrong. Back to Step 2b. |
| Staleness border on a widget | that widget's drawer | Last fetch > 2× TTL ago. Tap the refresh icon, then investigate. |

---

## Appendix B — Rollback plan

Every step is designed to fail safe:
- **Jira misconfigured?** Set the relevant `JIRA_<WIDGET>_JQL` to empty → widget shows a clean "JQL not configured" placeholder, not a crash.
- **Workday broken?** `WORKDAY_PROVIDER=none` → dashboard runs without Workday; Slack-only presence still works.
- **Slack scopes revoked?** Server stays up; `PRESENCE_MODEL=bot` (the old mode) or just set the two Slack env vars back to empty → boots in `WEB-ONLY MODE`.

No step is a one-way door.
