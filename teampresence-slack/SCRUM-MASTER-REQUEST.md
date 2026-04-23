# Scrum master / email eng lead — Jira JQL sign-off

Gen Pulse's 10 Jira widgets are live against the real EMOPS and EMAILCO projects. The JQL running right now is **correct-ish but conservative** — it gets the right ballpark numbers, but it hasn't been reviewed by someone who lives in the tickets every day. That's the ask: a sign-off (with edits) on the exact JQL per widget so the CSM team sees numbers they agree with.

---

## 📬 Email template — forward to the scrum master / eng lead

**Subject:** Gen Pulse — Jira JQL review for EMOPS + EMAILCO widgets (20 min of your time)

> Hi [scrum master / email eng lead name],
>
> Quick one. I've built an internal dashboard (Gen Pulse) that surfaces 10 Jira reports for the EMAIL NORTON CSM team — weekly throughput, backlog overview, SLA risk, top priority tickets, kanban snapshot, etc. It's live against real EMOPS data (and EMAILCO for the legacy view) and it's accurate, but the JQL is using defaults I chose by inspection, not defaults you've signed off on.
>
> **Ask:** 20 minutes of your time to review the JQL in `JQL-WORKBOOK.md` and either (a) approve it as-is, or (b) tell me what to change. For most widgets I've written a one-line "questions" block at the bottom (e.g. "should we exclude Epics from throughput?" / "is `sprint in openSprints()` the right sprint definition?") — those are the main decisions.
>
> **Where to find it:**
>
> - Repo doc: `teampresence-slack/JQL-WORKBOOK.md` (has the live defaults at the top + fill-in table per widget)
> - Live dashboard (works from your laptop + phone): I'll DM you the URL + access key directly — it's a Cloudflare tunnel pointed at my laptop, so I don't want to paste it in email. Once you're on, click the **filter chip** on any widget to see what JQL it's actually running.
> - (Note: the tunnel URL changes if I restart the server, so if the link stops working, just ping me for a fresh one.)
>
> **Context you might need:**
>
> - Priority allow-list is `P0, P1, P2` right now (we verified live that EMOPS uses P0-P4, not Highest/Critical/High). If you want to include P3 for the "Top priority" widget, just tell me.
> - EMOPS has 15+ bespoke workflow statuses (`Ready to Start`, `DEVELOPMENT In Progress`, `TARGETING In Progress`, `QA In Progress`, ...). Most widgets filter by `statusCategory = Done` or `!= Done`, which Jira handles for us. Tell me if any widget needs to pin a specific workflow status instead.
> - Nothing filters by label yet. If the team uses tags like `duplicate, spam, noise` to hide tickets, we should add an exclude filter globally.
> - The **"Both" view** (EMOPS + EMAILCO combined) uses `project in (EMOPS, EMAILCO)` and mirrors whatever decisions we make per-project.
>
> **How changes go in:** I edit one line per widget in `teampresence-slack/.env` and restart the server. Zero-downtime in practice — the data refetches on the next 30s tick. If you prefer to drive this via PR, I can open tickets per widget and you comment with the final JQL.
>
> Thanks — getting this right is the single biggest "does the team trust the dashboard" lever we have.
>
> Kevin
> EMAIL NORTON CSM

---

## ⚡ When the scrum master sends back JQL — 10-minute apply-and-ship loop

For each widget they've signed off on:

1. Open `teampresence-slack/.env`.
2. Find the line like:
  ```ini
   JIRA_EMOPS_THROUGHPUT_JQL=project = EMOPS AND statusCategory = Done AND resolved >= -7d
  ```
3. Replace the value after `=` with the scrum master's JQL (no quotes needed).
4. If they gave you DIFFERENT JQL for EMAILCO, update the `JIRA_EMAILCO_THROUGHPUT_JQL` line the same way.
5. If they gave you a "Both" aggregation that isn't just `project in (EMOPS, EMAILCO) AND <rest>`, update `JIRA_ALL_THROUGHPUT_JQL` too.

When all widgets are updated:

```bash
pkill -9 -f 'node src/index.js'
PORT=3000 node src/index.js &
sleep 3

# Confirm every widget returns data with the new JQL — no 500s, no empty datasets:
KEY=$(awk -F= '/^DASHBOARD_KEY=/{print $2}' teampresence-slack/.env)
for w in weekly-throughput backlog-overview top-priority-tickets inflow-vs-resolved \
         ticket-lifecycle kanban-board sla-aging-risk sprint-backlog reopen-rate \
         throughput-leaderboard; do
  for p in EMOPS EMAILCO all; do
    echo -n "$w / $p: "
    curl -s "http://localhost:3000/api/widgets/$w?project=$p&key=$KEY" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print("ok" if "error" not in d else "ERR: "+d["error"])'
  done
done
```

Any `ERR:` line → that widget's JQL has a syntax error. Fix in `.env`, restart, re-run.

---

## For the scrum master: JQL patterns we commonly adopt

None of these are defaults in Gen Pulse — they're just the patterns most CSM teams land on after one review cycle. Pick whichever make sense for EMAIL NORTON.

**Exclude noise from throughput:**

```jql
project = EMOPS AND statusCategory = Done AND resolved >= -7d
AND issueType in (Task, Story, Bug)
AND NOT (labels in (duplicate, spam, noise))
```

**Current sprint only, for backlog widgets:**

```jql
project = EMOPS AND statusCategory != Done AND sprint in openSprints()
```

**Only tickets your team owns, when the project is shared:**

```jql
project = EMOPS AND "Team" = "EMAIL NORTON CSM" AND statusCategory != Done
```

**Priority that respects your workflow:**

```jql
project = EMOPS AND resolution = Unresolved AND priority in (P0, P1, P2)
ORDER BY priority DESC, created ASC
```

(Gen Pulse adds the `ORDER BY` itself — don't include it in the JQL you paste into `.env`; it'll cause a parse error.)

**Exclude bot/service-account assignees from leaderboards:**

```jql
project = EMOPS AND statusCategory = Done AND resolved >= -7d
AND assignee not in (jira-bot, ci-user, automation-user)
```

---

## What NOT to tune (yet)

- Refresh cadence (fixed at 30s; if you want slower, we add a query param)
- Column orderings / sort directions — the dashboard owns presentation
- How many tickets to show per widget — those are `JIRA_<WIDGET>_LIMIT` knobs, separate from JQL
- Anything involving Jira Service Desk SLAs — not hooked up yet

---

## Handback

Once all 10 widgets have the scrum master's approved JQL in `.env`, update the "Reviewer sign-off" table in `JQL-WORKBOOK.md` and commit both files. That's the signal to senior management that the Jira data is production-signed.