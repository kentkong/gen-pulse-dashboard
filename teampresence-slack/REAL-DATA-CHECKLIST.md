# Real-data checklist

When you see a `DEMO` badge on a widget — or the amber "Demo data"
banner at the top of the dashboard — that widget is reading from
`src/preview.js`, not from real Jira / Slack / Workday.

This doc lists exactly what is needed to swap each source over to
live data, and who typically owns each item.

---

## 1. Jira (the 10 performance widgets)

**Demo-sourced widgets when this is not wired:**
weekly throughput · backlog overview · ticket lifecycle · inflow vs
resolved · SLA aging risk · kanban board · top priority tickets ·
sprint backlog · reopen rate · throughput leaderboard.

**What we need:**

| Item | Who owns | Notes |
|---|---|---|
| Jira base URL | IT | e.g. `https://jira.corp.nortonlifelock.com`. Must be reachable from the server running Gen Pulse. |
| Personal Access Token (PAT) | Scrum master / service-account owner | Read-only is fine. Bound to a service account is ideal so it doesn't break if a person leaves. |
| JQL per widget | Scrum master | See `.env.example` — 10 JQL vars, one per widget. Start with `JIRA_THROUGHPUT_JQL` and `JIRA_BACKLOG_JQL`; the rest fall back to those when unset. |

**Drop these into `.env`:**

```dotenv
JIRA_BASE_URL=https://jira.corp.nortonlifelock.com
JIRA_TOKEN=<PAT>
JIRA_THROUGHPUT_JQL=project = EMAIL AND statusCategory = Done
JIRA_BACKLOG_JQL=project = EMAIL AND statusCategory != Done
# ...see .env.example for the full list
```

**How to confirm it's real:** the amber banner drops the widget
endpoint from its list, and the per-widget `DEMO` badge vanishes.
The filter drawer on each widget shows the JQL + which env var was
used, so you can verify the query against Jira directly.

---

## 2. Slack presence (Team Presence widget)

**Demo-sourced when this is not wired:**
status buckets, source chips, the "N/N resolved" number on the
presence-health chip.

**What we need:**

| Item | Who owns | Notes |
|---|---|---|
| Slack bot token | Slack workspace admin | `xoxb-...`. Issued when the app is installed. |
| Signing secret | Slack workspace admin | Configured on the Slack app's Basic Information page. |
| Three bot scopes | Slack workspace admin | `users:read`, `users.profile:read`, `users:read.presence`. Add under OAuth & Permissions → Bot Token Scopes. **Reinstall the app after adding.** |
| Roster mapping | Team lead | Edit `src/team.js` and fill the `slackIds: [...]` array for each of the 8 roster entries. |

**Drop these into `.env`:**

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
PRESENCE_MODEL=slack     # or slack+workday
```

**How to confirm it's real:** the presence-health chip turns green
and shows `Slack 8/8 resolved · just now`. Each member's row on the
Team Presence table shows a `via Slack` source chip instead of
`demo`.

---

## 3. Workday (Out today / Out next 7 days)

**Demo-sourced when this is not wired:**
the hero "Out today" strip, the "Out next 7 days" carousel, the
Vacation bucket overrides on per-member rows.

**Pick one of three providers** (see `WORKDAY.md` for the full
playbook):

### Option A — CSV stopgap (works today, no IT)

```dotenv
PRESENCE_MODEL=slack+workday
WORKDAY_PROVIDER=csv
WORKDAY_CSV_PATH=./data/workday-absences.csv
```

Copy `data/workday-absences.example.csv` to
`data/workday-absences.csv` and edit as team leads request PTO.
Re-read every 5 min without a restart.

### Option B — iCal (simplest IT integration)

Ask IT for an `.ics` URL (Workday, Outlook, or Google Calendar will
all work). Then:

```dotenv
WORKDAY_PROVIDER=ical
WORKDAY_ICAL_URL=https://...
WORKDAY_ICAL_TYPE_MAP=Sick=*Sick*, Holiday=*Holiday*, PTO=*
```

### Option C — REST (what IT probably wants eventually)

```dotenv
WORKDAY_PROVIDER=rest
WORKDAY_ENDPOINT=https://wd.example.com/v1/absences
WORKDAY_TOKEN=<bearer>
```

**How to confirm it's real:** the presence-health chip reads
`Workday (csv|ical|rest) N out · M upcoming`. The hero + carousel
surface the actual absences, not the sample Ibiza / Flu rows from
the demo CSV.

---

## 4. How to test locally without affecting anyone

You can point the real dashboard at a read-only Jira PAT without
affecting the team. The service does not write to Jira — only
GET calls. Same for Slack (we read status/presence; the bot never
posts unless you also wire the legacy commands).

Run one of:

```bash
# Option 1: real env vars via .env (copy .env.example → .env first)
npm start

# Option 2: ad-hoc, without persisting the token
JIRA_BASE_URL=https://... JIRA_TOKEN=... npm start
```

The preview server (`node src/preview.js`, what the Cloudflare
tunnel currently points to) will keep returning demo data and the
banner will keep showing — it has no Jira credentials, by design.

---

## 5. Priority order when wiring this up for production

1. **Slack presence first.** Lowest friction (just bot scopes), and
   the "is this data accurate?" question gets answered instantly
   by the presence-health chip.
2. **Workday via CSV.** Get vacations right before touching IT.
3. **Jira.** Highest value for directors, needs JQL tuning per
   widget — plan to iterate on the queries for a week before
   declaring numbers "accurate".
4. **Workday via iCal or REST.** Migrate off CSV once IT has given
   you a URL / endpoint.
