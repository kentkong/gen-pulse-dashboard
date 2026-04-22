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

### 3b. Once approved [it → you]

They will give you three values — `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and optionally `SLACK_APP_TOKEN`. Put them into `.env`.

### 3c. Match Slack user IDs to the roster [you]

Each roster entry in `src/team.js` has an empty `slackIds: []` array. Populate it with each person's Slack user ID (format `U0...`). You can get these by running (once Slack is connected):
```
curl -sS -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/users.list | jq '.members[] | {id, name: .profile.real_name}'
```

### 3d. Flip the feature flag [you / ops]

In `.env`:
```
PRESENCE_MODEL=slack+workday   # or just slack if no Workday yet
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

Swap the current `DASHBOARD_KEY` gate for Azure AD SSO. See `USER-ACCOUNT-PLAN.md` for the concrete design.

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
