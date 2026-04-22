# Gen Pulse

> The daily command center for CSM teams — a mobile-first companion to
> Gen Central with real-time performance, workflow, and Team Presence.

Gen Pulse gathers your most valuable information, spread across
multiple separate platforms, into one easily accessible feed. From
Jira kanban boards and hot campaign topics, to Workday vacations,
Slack presence, and team performance — Pulse gives managers,
directors, and team members real-time updates on the data that
matters most, all in one mobile and desktop application. No more
segregated data and reports; everything together.

This repo contains:

- A **Node.js web dashboard** (`src/preview.js` for demos,
  `src/index.js` for the real server) with 10+ Jira-sourced widgets,
  Workday absence integration, and a Slack-status-backed Team
  Presence panel.
- A **Slack bot** (`@slack/bolt`) for slash commands, weekly report
  posts, and optional interactive check-ins.
- An opinionated **design system** (Gen Digital palette, dark/light
  mode, mobile-first) and an extensible **widget architecture**.

---

## Quickstart — demo in 60 seconds

No Slack / Jira / Workday credentials required. Runs entirely on
fixture data from `src/preview.js`.

```bash
cd teampresence-slack
npm install
PORT=3100 node src/preview.js
# open http://localhost:3100
```

Toggle **Team / Manager** view from the pill in the top-right. Tap
any widget's filter chip to see the exact JQL, source, and refresh
cadence that produced the numbers.

---

## Quickstart — real server (Jira + Workday + Slack)

```bash
cd teampresence-slack
npm install
cp .env.example .env      # then edit — at minimum set DASHBOARD_KEY
npm start                 # starts src/index.js on PORT (default 3000)
```

If Slack credentials are missing, Gen Pulse boots in **WEB-ONLY
MODE**: Jira + Workday integrations work, Slack-sourced features
(slash commands, live profile/presence, chat alerts) are disabled
until you fill `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in
`.env`. The startup banner makes the current mode obvious.

For the full, sequenced go-live (Jira PAT → Workday CSV → Slack
admin approval → production hosting → SSO), follow
[`GO-LIVE-RUNBOOK.md`](./GO-LIVE-RUNBOOK.md).

---

## Documentation index

Seven docs cover every corner of the project. Read them in this
order to take Pulse from demo to production:

| # | Doc | For | What it covers |
|---|-----|-----|----------------|
| 1 | [`GO-LIVE-RUNBOOK.md`](./GO-LIVE-RUNBOOK.md) | You + lead dev | Step-by-step: demo → production. Every step has a "Who", "Prereq", commands, and an explicit "Success test". Start here. |
| 2 | [`REAL-DATA-CHECKLIST.md`](./REAL-DATA-CHECKLIST.md) | Ops / data owners | One-page checklist of exactly which env vars / files flip each widget from demo to real data. |
| 3 | [`JQL-WORKBOOK.md`](./JQL-WORKBOOK.md) | Scrum master / CSM lead | Each of the 10 Jira widgets × 2 projects (EMOPS, EMAILCO): intent, example JQL, blank for prod JQL, reviewer sign-off. This file **is** the source of truth for what the widgets query. |
| 4 | [`SLACK-ADMIN-REQUEST.md`](./SLACK-ADMIN-REQUEST.md) | Slack workspace admin | Copy-paste email template: scopes, justification, hosting, data handling, admin FAQ. |
| 5 | [`WORKDAY.md`](./WORKDAY.md) | HR / IT + ops | How the Workday provider chain works (CSV → iCal → REST), including the roster-match rules and the template file for HR. |
| 6 | [`USER-ACCOUNT-PLAN.md`](./USER-ACCOUNT-PLAN.md) | IT / security | Design doc for the top-right sign-in: Azure AD OIDC + PKCE, claims → roles mapping, rollout plan, security considerations. |
| 7 | [`data/workday-absences.template.csv`](./data/workday-absences.template.csv) | HR (practitioner) | Pre-populated template for entering real PTO data. Copy to `data/workday-absences.csv` and fill. |

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│                   Browser (mobile + desktop)                  │
│   public/index.html  — hero, Team view, Manager view,         │
│                         user pill, theme toggle, 10+ widgets  │
└──────────────┬────────────────────────────┬───────────────────┘
               │ /api/me                     │ /api/widgets/:id
               │ /api/team                   │ (per-widget cache)
               ▼                             ▼
┌──────────────────────────────────────────────────────────────┐
│  src/index.js  (full mode)    src/preview.js  (demo fixtures) │
│  ├─ src/web.js     routes + auth (src/auth.js shim)           │
│  ├─ src/widgets.js per-widget builders + cache                │
│  ├─ src/jira.js    JQL execution + fallback chain             │
│  ├─ src/jira-projects.js  EMOPS/EMAILCO resolver              │
│  ├─ src/presence/  slack-status + workday + mapping           │
│  ├─ src/workday/   CSV / iCal / REST providers                │
│  └─ src/reports.js weekly scheduled Slack posts               │
└──────────────┬────────────────┬──────────────┬────────────────┘
               │                │              │
               ▼                ▼              ▼
           Jira REST       Workday feed    Slack Bolt
        (JIRA_BASE +     (CSV/iCal/REST)  (bot token +
         PAT or basic)                     signing secret)
```

Everything between the browser and the outside world is modular
and feature-flagged — see
[`USER-ACCOUNT-PLAN.md`](./USER-ACCOUNT-PLAN.md) for how OIDC
slots in without touching route code, and
[`WORKDAY.md`](./WORKDAY.md) for the provider chain.

---

## Views

### Team view (default)
The CSM-team dashboard: Today at a glance, Team Presence, Jira
widgets (throughput, backlog, top priority, SLA risk, kanban…),
absences panel.

### Manager / Director view
Same data, leadership perspective. 4 cross-team KPI cards
(Out today / Blockers / SLA risk / Throughput) at the top,
per-team tiles below. Toggle with the **Team / Manager** pill in
the header, or link directly with `?view=manager`. Managers and
directors auto-land here once SSO is wired (role is read from
`/api/me`).

---

## Slack commands (full mode only)

These still work when Slack is connected; the web dashboard does
not depend on them.

- `/teampresence away <reason>` — store where you are (meeting,
  travel, focus) with optional **until** time.
- `/teampresence here` — mark available again.
- `/teampresence roster` — list channel members and what they
  last saved (run in a channel).
- `/teampresence rollcall "Meeting"` — posts
  **Attending / Late / Absent** buttons; responses are stored.
- `/teampresence missed <id>` — channel members who have not
  clicked any button for that roll call yet.

Data is persisted in SQLite at `DATABASE_PATH` (default
`./data/teampresence.db`).

---

## Environment variables (essentials)

See `.env.example` for the full list with comments. The minimum
set for a demo with real Jira data:

| Variable | What |
|---|---|
| `DASHBOARD_KEY` | Shared secret for `/api/*` access (required). |
| `JIRA_BASE` | Jira base URL (e.g. `https://jira.corp.nortonlifelock.com`). |
| `JIRA_PAT` | Personal Access Token. Set with `./scripts/set-jira-token.sh` to avoid leaking into shell history. |
| `JIRA_DEFAULT_PROJECT` | `EMOPS` or `EMAILCO`. |
| `WORKDAY_ABSENCE_CSV` | Path to the filled-in absence CSV. |
| `PRESENCE_MODEL` | `slack+workday` (recommended), `slack`, or `bot` (legacy). |
| `AUTH_STRATEGY` | `shared-key` today, `oidc` when SSO is wired. |

---

## Project layout

```
teampresence-slack/
├── public/index.html          # single-page dashboard
├── src/
│   ├── index.js               # real server entry point
│   ├── preview.js             # demo / fixture server
│   ├── web.js                 # HTTP routes + authn
│   ├── auth.js                # authenticator interface (shared-key → OIDC)
│   ├── widgets.js             # widget registry + per-widget cache
│   ├── jira.js                # JQL execution
│   ├── jira-projects.js       # EMOPS / EMAILCO resolver
│   ├── filters.js             # filter metadata for the drawer
│   ├── presence/              # slack-status, workday, mapping, aggregator
│   ├── workday/               # CSV / iCal / REST providers
│   ├── reports.js             # scheduled weekly Slack posts
│   └── team.js                # roster (single source of truth)
├── data/
│   ├── workday-absences.template.csv   # HR template
│   └── teampresence.db        # SQLite (created on first run)
├── scripts/set-jira-token.sh  # secure PAT storage helper
├── GO-LIVE-RUNBOOK.md         # the playbook
├── JQL-WORKBOOK.md            # Jira queries per widget × project
├── SLACK-ADMIN-REQUEST.md     # admin approval email
├── WORKDAY.md                 # provider chain + CSV format
├── USER-ACCOUNT-PLAN.md       # OIDC / Azure AD design
├── REAL-DATA-CHECKLIST.md     # demo → real cheat-sheet
└── README.md                  # this file
```

---

## License

Internal Gen Digital project. Not for external distribution.
