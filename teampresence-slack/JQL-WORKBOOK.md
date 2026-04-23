# Gen Pulse — JQL Workbook

**Purpose:** Pin down the exact JQL for every Jira-powered widget, for both the current (`EMOPS`) and legacy (`EMAILCO`) projects, so the dashboard shows what the CSM / dev teams actually expect.

---

## 🚦 Current live defaults (as of latest deploy)

Everything below is **already working** against real Jira — the scrum master's job is to tune these so they match how the team thinks about the metric, not to build from zero.

| Widget | EMOPS JQL (live today) | EMAILCO JQL (live today) |
| ------ | ---------------------- | ------------------------ |
| Weekly throughput | `project = EMOPS AND statusCategory = Done AND resolved >= -7d` | `project = EMAILCO AND statusCategory = Done AND resolved >= -7d` |
| Backlog overview  | `project = EMOPS AND statusCategory != Done` | `project = EMAILCO AND statusCategory != Done` |
| Top priority      | `project = EMOPS AND statusCategory != Done` + `priority in (P0, P1, P2)` | same, with EMAILCO |
| Inflow vs resolved | `project = EMOPS AND created >= -14d` | same, EMAILCO |
| Ticket lifecycle  | `project = EMOPS AND statusCategory = Done AND resolved >= -30d` | same, EMAILCO |
| Kanban board      | `project = EMOPS AND statusCategory != Done` | same, EMAILCO |
| SLA / aging risk  | (uses `backlog` JQL + SLA thresholds env) | same |
| Sprint backlog    | (uses `backlog` JQL + optional sprint-name filter) | same |
| Reopen rate       | (uses `lifecycle` JQL) | same |
| Throughput leaderboard | (uses `throughput` JQL + assignee field) | same |

**What's intentionally conservative:**

- Priority allow-list is `P0, P1, P2` (we discovered live that EMOPS uses P0-P4, not Highest/Critical/High)
- Status filter on "Top priority" is `<empty>` — a P0 ticket is a priority whatever column it's in, so we don't narrow by status
- No issue-type filter on anything yet (you may want `issueType in (Task, Story, Bug)` on throughput to exclude Epics/Sub-tasks)
- No sprint-name filter (you may want `sprint in openSprints()` on backlog)
- No label filter (you may want to exclude `duplicate, noise, spam`)

**Where you override these:** edit `teampresence-slack/.env` and restart the server. Every widget has a `JIRA_EMOPS_<WIDGET>_JQL` + `JIRA_EMAILCO_<WIDGET>_JQL` + `JIRA_ALL_<WIDGET>_JQL` variable. See the fenced `.env` block at the end of this doc for the full list.

**How to see what the widget is actually running:** on the dashboard, click the **filter chip** on any Jira widget — it shows the resolved JQL, source env var, and fallback chain. No guessing.

---

**How to use this doc:**

1. Read the widget's **Intent** — that's what the CSM team will see.
2. Review the **Example JQL** (current demo) and adjust it until it matches how your team thinks about that metric.
3. Paste the final JQL into the `PROD JQL` field for **both** projects.
4. Once every widget has real JQL for at least one project, ops puts the values into `.env`, restarts the server, and the filter drawers on the dashboard will show exactly what's running.
5. Widgets without a project-specific JQL fall back to the legacy `JIRA_<WIDGET>_JQL` (single-project) — see the bottom of `.env.example`.

**Resolution rules (for reference):**

- `project = EMOPS` ⇒ current board.
- `project = EMAILCO` ⇒ legacy board (read-only in most people's heads).
- `project in (EMOPS, EMAILCO)` ⇒ "Both" view (union across projects).
- Fall-back precedence: **per-project JQL** → **legacy single-project JQL** → **widget-default fallback** in `src/jira-projects.js`.

**Reviewer sign-off:**

| Reviewer | Role | Date | Sign-off |
| -------- | ---- | ---- | -------- |
|          | CSM lead           | | |
|          | Email Marketing eng lead | | |
|          | Scrum master       | | |

---

## 1. Weekly throughput (`weekly-throughput`)

- **Intent:** "How many tickets did we actually finish in the last 7 rolling days, broken down by day?" — used for the big hero sparkline at the top of the board.
- **Env vars:** `JIRA_EMOPS_THROUGHPUT_JQL`, `JIRA_EMAILCO_THROUGHPUT_JQL`, `JIRA_ALL_THROUGHPUT_JQL`
- **Tuning knobs:** `JIRA_<PROJECT>_THROUGHPUT_TEAM_FIELD` (e.g. "Team"), `JIRA_<PROJECT>_THROUGHPUT_ISSUE_TYPES` (defaults to all).

| Field | Example (current demo) | PROD JQL — EMOPS | PROD JQL — EMAILCO |
| ----- | ---------------------- | ---------------- | ------------------ |
| JQL   | `project = EMOPS AND statusCategory = Done AND resolved >= -7d` | _fill in_ | _fill in_ |
| Issue types to include | `Task, Story, Bug` | | |
| Exclude labels (comma)  | `duplicate, noise` | | |

**Questions to resolve:** Do we count sub-tasks? What about issues resolved then re-opened? Do we want only issues with a Story Point value, or all?

---

## 2. Backlog overview (`backlog-overview`)

- **Intent:** "How big is the backlog right now and is it growing or shrinking week over week?"
- **Env vars:** `JIRA_EMOPS_BACKLOG_JQL`, `JIRA_EMAILCO_BACKLOG_JQL`, `JIRA_ALL_BACKLOG_JQL`
- **Tuning knobs:** `JIRA_<PROJECT>_BACKLOG_BUCKETS` (age buckets in days, e.g. `7,30,60`).

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL   | `project = EMOPS AND statusCategory != Done` | _fill in_ | _fill in_ |
| Age buckets (days) | `7, 30, 60, 90+` | | |

**Questions:** Do we include issues in `Selected for Development` or only truly waiting? What statuses equate to "parking lot" that should NOT count?

---

## 3. Ticket lifecycle (`ticket-lifecycle`)

- **Intent:** "How long does a CSM ticket typically live from creation to resolution? Are we trending up or down versus the previous 30 days?"
- **Env vars:** `JIRA_EMOPS_LIFECYCLE_JQL`, `JIRA_EMAILCO_LIFECYCLE_JQL`, `JIRA_ALL_LIFECYCLE_JQL`,
  plus a **previous period** variant: `JIRA_EMOPS_LIFECYCLE_PREV_JQL`, `JIRA_EMAILCO_LIFECYCLE_PREV_JQL`.

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL (current 30 days) | `project = EMOPS AND statusCategory = Done AND resolved >= -30d` | _fill in_ | _fill in_ |
| JQL (previous 30 days, for delta) | `project = EMOPS AND statusCategory = Done AND resolved >= -60d AND resolved < -30d` | _fill in_ | _fill in_ |

**Questions:** Do we exclude weekends from "time in status"? Exclude tickets that were on-hold / blocked externally?

---

## 4. Inflow vs resolved (`inflow-vs-resolved`)

- **Intent:** "Are we taking on more tickets than we're closing? Visualised as a 14-day dual-bar."
- **Env vars:** `JIRA_EMOPS_INFLOW_JQL`, `JIRA_EMAILCO_INFLOW_JQL`, `JIRA_ALL_INFLOW_JQL`

The widget internally uses the one JQL as the **scope** and then layers `created >= -14d` / `resolved >= -14d` filters on top. So the JQL here should define "what counts as a CSM ticket" for this team.

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| Scope JQL | `project = EMOPS` | _fill in_ | _fill in_ |

**Questions:** Include bugs? Include sub-tasks? Include internal housekeeping tickets?

---

## 5. SLA / aging risk (`sla-aging-risk`)

- **Intent:** "Which open tickets are at risk of breaching SLA? Flag anything high-priority open > 72h."
- **Env vars:** `JIRA_EMOPS_SLA_JQL`, `JIRA_EMAILCO_SLA_JQL`, `JIRA_ALL_SLA_JQL`
- **Tuning knobs:** `JIRA_<PROJECT>_SLA_AGE_HOURS` (default 72), `JIRA_<PROJECT>_SLA_PRIORITIES` (default Highest,Critical,High).

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL   | `project = EMOPS AND statusCategory != Done AND priority in (Highest, Critical, High)` | _fill in_ | _fill in_ |
| SLA breach threshold (hours) | `72` | | |

**Questions:** Is there an official SLA policy? Is there already a Jira SLA/time-tracking field we should read from?

---

## 6. Sprint backlog (`sprint-backlog`)

- **Intent:** "What's in the active sprint right now, and who owns it?" If `EMAILCO` doesn't run sprints, use a rolling 14-day `Selected for Development` view instead.
- **Env vars:** `JIRA_EMOPS_SPRINT_BACKLOG_JQL`, `JIRA_EMAILCO_SPRINT_BACKLOG_JQL`, `JIRA_ALL_SPRINT_BACKLOG_JQL`

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL   | `project = EMOPS AND sprint in openSprints()` | _fill in_ | _fill in_ (no sprints — use `resolution = Unresolved AND updated >= -14d`) |

**Questions:** For EMAILCO, what's the equivalent of "active sprint"? Roadmap epic? Board column?

---

## 7. Reopen / escalation rate (`reopen-rate`)

- **Intent:** "How often are we closing tickets and having them reopened — or escalated to another team?"
- **Env vars:** `JIRA_EMOPS_REOPEN_JQL`, `JIRA_EMAILCO_REOPEN_JQL`, `JIRA_ALL_REOPEN_JQL`

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| Scope JQL | `project = EMOPS` | _fill in_ | _fill in_ |
| Reopen detector (changelog query) | `status changed from "Done" to NOT "Done"` | | |

**Questions:** Do escalations go via label (`escalated`), component (`Platform`), or new issue links? The widget can be tuned — tell us the signal.

---

## 8. Top priority tickets (`top-priority-tickets`)

- **Intent:** "Top 10 unresolved tickets ranked by priority then age — a call-list for the day."
- **Env vars:** `JIRA_EMOPS_TOP_PRIORITY_JQL`, `JIRA_EMAILCO_TOP_PRIORITY_JQL`, `JIRA_ALL_TOP_PRIORITY_JQL`
- **Tuning knobs:** `JIRA_<PROJECT>_TOP_PRIORITY_LIMIT` (default 10).

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL   | `project = EMOPS AND resolution = Unresolved ORDER BY priority DESC, created ASC` | _fill in_ | _fill in_ |

**Questions:** What priority levels do we recognise? Should "assignee is the current on-call" be baked in?

---

## 9. Throughput leaderboard (`throughput-leaderboard`)

- **Intent:** "Who resolved the most tickets in the last N days, broken out by ticket type?" Used for friendly team recognition; this is NOT a performance review tool.
- **Env vars:** `JIRA_EMOPS_LEADERBOARD_JQL`, `JIRA_EMAILCO_LEADERBOARD_JQL`, `JIRA_ALL_LEADERBOARD_JQL`
- **Tuning knobs:** `JIRA_<PROJECT>_LEADERBOARD_WINDOW_DAYS` (default 7), `JIRA_<PROJECT>_LEADERBOARD_LIMIT` (default 10).

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL   | `project = EMOPS AND statusCategory = Done AND resolved >= -7d` | _fill in_ | _fill in_ |

**Questions:** Is "assignee at resolution time" or "last assignee" the right attribution? Exclude tickets assigned to bots / service accounts?

---

## 10. Kanban snapshot (`kanban-board`)

- **Intent:** "Mini mirror of the Jira board — To Do / In Progress / Review / Done — with top items in each lane. A glance at where work actually sits."
- **Env vars:** `JIRA_EMOPS_KANBAN_JQL`, `JIRA_EMAILCO_KANBAN_JQL`, `JIRA_ALL_KANBAN_JQL`
- **Tuning knobs:** `JIRA_<PROJECT>_KANBAN_LANES` (default `To Do, In Progress, Review, Done`).

| Field | Example | EMOPS | EMAILCO |
| ----- | ------- | ----- | ------- |
| JQL   | `project = EMOPS AND resolution = Unresolved ORDER BY Rank` | _fill in_ | _fill in_ |
| Lane → status mapping | `To Do = "To Do"; In Progress = "In Progress"; Review = "In Review"; Done = "Done" (capped at 5)` | | |

**Questions:** Same lanes on EMAILCO or a different workflow? If the workflow has custom statuses, list them and the ideal lane mapping.

---

## Connectivity

Once the JQL is agreed:

1. Get a Jira Personal Access Token from https://your-jira/plugins/servlet/de.resolution.apitokenauth/admin (or Atlassian > Profile > API tokens).
2. Run `./scripts/set-jira-token.sh` — it will prompt for the PAT privately and store it in `.env`. Never paste PATs in chat/email.
3. Paste the agreed JQL values into the relevant `JIRA_<PROJECT>_<WIDGET>_JQL=` lines in `.env`.
4. Restart the server (`npm start`). The filter drawer on each widget now reflects the live JQL + row counts.

If a widget shows a red "error" chip after the real JQL goes in, open its filter drawer — the exact HTTP error from Jira (permissions, syntax, 401) is surfaced there.
