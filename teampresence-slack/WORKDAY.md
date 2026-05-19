# Workday integration — configuration playbook

Gen Pulse turns Workday absence data into three surfaces:

1. **Per-member "Vacation" bucket** on the Team Presence card (wins
   over Slack status).
2. **"Out today" hero strip** above the Team Presence widget — one
   head-count, names, dates.
3. **"Out next 7 days" carousel** below the Team Presence table —
   horizontal coverage view for managers.

All three are driven by a single provider. Pick the one that matches
the level of Workday access IT has given you, then move up as more
becomes available.

> **Strategic direction (2026-04-24).** The agreed long-term state
> for Gen is **Workday → Outlook calendar → Slack presence → Gen
> Pulse**, i.e. no direct Workday integration from this app. Once the
> Workday-to-Outlook sync is live for our org, the dashboard picks up
> absences automatically via the Slack presence path (see
> `slack-status.js`) and the providers below become fallbacks rather
> than the primary feed. Until that sync is switched on, the `csv`
> provider is the demo path — see `HR-WORKDAY-REQUEST.md` for the
> interim delivery status.

---

## The four providers

| Provider | Env `WORKDAY_PROVIDER` | Needs from IT | Ops cost | Use when |
|---|---|---|---|---|
| **noop** | `none` (or unset) | nothing | zero | You're still evaluating. |
| **csv**  | `csv`  | nothing (you maintain the file) | low | IT conversation is slow; you need the demo to be real today. |
| **ical** | `ical` | a `.ics` URL | low | Workday tenant exposes a calendar feed; simplest auth-free integration. |
| **rest** | `rest` | a JSON endpoint + bearer token | medium | IT has built (or will build) a proper API. |

> All providers share one cache (5 min TTL). Switching is a one-line
> `.env` change; no code changes required.

---

## Fast path — CSV today

**Goal:** Workday vacations visible in the dashboard in under 2 minutes,
without talking to IT.

1. Copy the bundled example to an active file:
   ```bash
   cp data/workday-absences.example.csv data/workday-absences.csv
   ```
2. Add to `.env`:
   ```dotenv
   PRESENCE_MODEL=slack+workday
   WORKDAY_PROVIDER=csv
   WORKDAY_CSV_PATH=./data/workday-absences.csv
   ```
3. Restart the server.
4. Edit `data/workday-absences.csv` as new PTOs are requested. The file
   is re-read every 5 minutes — no restart needed.

**CSV schema** (header-driven; column order doesn't matter):

| Column | Required? | Example | Notes |
|---|---|---|---|
| `slackId` | one of the three | `U01ABCDEF` | Preferred match key. |
| `email` | one of the three | `jane@example.com` | Case-insensitive. |
| `slug` | one of the three | `daniel-zabensky` | Matches `src/team.js`. Useful before Slack IDs are wired. |
| `startDate` | yes | `2026-04-20` | Inclusive. |
| `endDate` | yes | `2026-04-25` | Inclusive. |
| `type` | no | `PTO` | One of `PTO`, `Sick`, `Holiday`, `Personal`, `Leave`. Default `PTO`. |
| `note` | no | `Ibiza` | Free-form. Shown in the drawer tooltip only (not publicly). |

Rows starting with `#` are comments. Blank lines are ignored.

---

## Mid path — iCal

**Goal:** Live sync against a Workday / Outlook / Google calendar feed
— no manual CSV upkeep, no custom API work.

1. Ask IT for the absence calendar URL. Any RFC 5545 `.ics` feed works:
   Workday's built-in calendar export, a shared Outlook group calendar,
   or a Google Calendar with the team's PTOs. Authentication-free URLs
   are ideal; a signed URL (e.g. with a query-string token) is fine.
2. `.env`:
   ```dotenv
   PRESENCE_MODEL=slack+workday
   WORKDAY_PROVIDER=ical
   WORKDAY_ICAL_URL=https://...your.ics...
   # Optional: classify summaries into absence types
   WORKDAY_ICAL_TYPE_MAP=Sick=*Sick*, Holiday=*Holiday*, PTO=*
   ```
3. Restart the server.

**Matching:** iCal events are matched to the roster by `ATTENDEE` email
(or `ORGANIZER` email if no attendee is present). Make sure the feed's
attendee emails match what `users.info` returns from Slack, or add
the corporate email address to `src/team.js`.

**Type classification:** iCal has no standard "absence type" field, so
we use the event `SUMMARY`. `WORKDAY_ICAL_TYPE_MAP` is evaluated
left-to-right; the first pattern that matches wins. `*` is a wildcard
(matches anything or use it as the catch-all at the end).

---

## Long path — REST

**Goal:** Production-grade integration that IT owns end to end.

1. Agree on a response shape with IT. The provider accepts:
   ```json
   [
     {
       "employeeEmail": "jane@example.com",
       "startDate": "2026-04-20",
       "endDate":   "2026-04-25",
       "type":      "PTO",
       "note":      "Spring break"
     }
   ]
   ```
   Or the paginated variant:
   ```json
   {
     "results": [ ... ],
     "next":    "https://.../absences?cursor=abc"
   }
   ```
   `employeeEmail` can be swapped for `slackId` or `slug` if IT prefers.
2. `.env`:
   ```dotenv
   PRESENCE_MODEL=slack+workday
   WORKDAY_PROVIDER=rest
   WORKDAY_ENDPOINT=https://wd.example.com/v1/absences
   WORKDAY_TOKEN=<bearer-token>
   # Optional: extra headers if IT needs them
   WORKDAY_REST_HEADERS={"X-Org-Id":"email-norton"}
   ```
3. Restart.

**If IT's shape doesn't match ours:** Don't ask them to change it.
Open `src/presence/workday.js`, pass a `transform` function into
`createRestWorkdayProvider({ transform })`, and map their shape into
ours in one place.

---

## What about Slack scopes?

Independent of Workday, the Slack-status side of this feature needs
the bot to have:

- `users:read`
- `users.profile:read`

Add them in `api.slack.com → OAuth & Permissions → Bot Token Scopes`
and reinstall the app. The Slack provider will log a warning for each
user it can't resolve.

> **Note on `users:read.presence`.** In the Slack v2 bot-app developer
> console, presence is bundled into `users:read` — there is no separate
> `users:read.presence` pick-list item. The two scopes above are
> sufficient for the EMAIL NORTON Slack app (`A0AUY7JRG5T`, see
> `SLACK-ADMIN-REQUEST.md`). Legacy docs that list three scopes are
> referring to classic apps.

---

## Privacy

Workday knows the *exact* absence type (Sick vs PTO vs Bereavement).
The public dashboard **never shows that directly** — every row renders
as "Vacation" for the whole team to see. The specific type is
exposed only in:

- The filter-drawer tooltip (hover the card)
- Future manager/director role-gated views (see `director_scope`
  todo)

The backend still returns the `type` field in `/api/absences` —
privacy is enforced in the rendering layer (`publicAbsenceLabel()` in
`public/index.html`). Treat this as a soft boundary and plan role-
gated hard-gating before sharing the dashboard beyond the immediate
team.

---

## Smoke test

```bash
# With PRESENCE_MODEL=slack+workday and WORKDAY_PROVIDER=csv:
curl -s "http://localhost:3000/api/absences?days=7" | jq .

# Expect:
#   { "source": "csv",
#     "windowDays": 7,
#     "today":    [ ... ],    # people out RIGHT NOW
#     "upcoming": [ ... ],    # starting in the next 7 days
#     "totals":   { "today": N, "upcoming": M } }
```

On the web UI, the "Out today" strip appears above the Team Presence
KPIs, and the "Out next 7 days" carousel appears below the member
table. Both are hidden automatically when empty.

---

## Rollback

`PRESENCE_MODEL=bot` reverts the whole stack to the original bot-driven
check-in model instantly. No data is lost — rollcalls and check-ins
continue to live in SQLite. The Workday provider is inert when the
flag isn't `slack+workday`, so the CSV file can stay on disk.
