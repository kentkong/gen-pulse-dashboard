# HR / People Ops — Workday absence feed for Gen Pulse

Gen Pulse shows the EMAIL NORTON team who's on vacation / sick / leave today and who'll be out in the next 7 days. It currently reads a CSV file we maintain by hand from Workday exports — that's fine for the pilot, but we'd like HR to own the data going forward so it's always up to date with no engineering loop.

---

## 📌 Status — 2026-04-24

**Interim demo:** ✅ Unblocked. One-off Workday-native absence export for the EMAIL NORTON team (current + next ~2 weeks) received from the HR contact and landed in the dashboard. The file lives under `data/` (gitignored) and is consumed by the existing `csv` provider; the parser resolved every row to the roster with zero unmatched. Provenance + cleanup notes are captured in the header of the active file so future handoffs are trivial.

**Long-term path (agreed in principle, not committed to a date):** Workday absences flow into the corporate Outlook calendar, Slack mirrors the resulting calendar state as presence, and Gen Pulse picks it up via Slack — i.e. no direct Workday integration on our side. The `ical` / `rest` / `csv` providers documented below stay in the codebase as a fallback, but the target operating state is Slack-driven once the upstream Workday → Outlook sync is switched on for our org.

**Privacy note:** Workday → Outlook rollout on the HR side is an internal-only project; don't paste the interim CSV or its contents into any Slack channel, wiki, or external doc. Keep it on the host filesystem (already gitignored).

---

## ✅ Interim scope agreed with HR (April 2026)

After the call with [HR contact] + Andy, the agreed first delivery for Alan Rogoyski's demo is **a one-off Workday report**, not an API. Specifically:


| Item                         | Agreed for first demo                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery format              | One-off CSV / Excel report (not a live API)                                                                                                                   |
| Scope of people              | The EMAIL NORTON team (8 people — see roster below)                                                                                                           |
| Fields requested             | Person + Start date + End date + Duration (day / half-day)                                                                                                    |
| Fields intentionally dropped | **PTO type** (Sick / Holiday / Personal) — HR asked to leave this off for the first cut. The dashboard will show "Time off" instead of the specific sub-type. |
| Future API path              | Satish Yalamandi's integrations BA team + Andy + Ivra. Post-demo.                                                                                             |


**What this means for the code:** the CSV parser (`src/presence/workday.js`) accepts the simplified report out of the box — Workday's native column names (`Worker Name`, `Start Date`, `End Date`, `Duration`, with or without a `Comment` column) all resolve automatically. Half-day entries are tagged `½ day` in the note. Rows with no `type` column default to the generic label `Time off` in the manager drill-down view, and "Vacation" on the public dashboard. No format reshaping step is required between HR sending the file and the dashboard reading it.

---

## 📬 Email template — forward to HR / People Ops

**Subject:** 10-minute ask — keep a tiny CSV of EMAIL NORTON PTO for internal dashboard

> Hi [HR contact / People Ops],
>
> Quick one. We've built a dashboard (Gen Pulse) for the EMAIL NORTON CSM team that, among other things, shows who's out on PTO today and who's out in the next 7 days. It's mobile-first, used daily by the team, and senior management has approved rolling it wider across CSM.
>
> Today, the PTO data comes from Slack statuses (which people forget to set before going on holiday) and a hand-maintained CSV. We'd like to make it reliable by sourcing it from Workday directly. Two options, take whichever is easiest:
>
> **Option A — CSV export from Workday (easiest)**
>
> - You export a simple 7-column CSV whenever the team's absences change (or on a weekly cadence — we only care about **current + next 14 days**).
> - Drop it into a shared location we both have read access to. I can pick it up from OneDrive/SharePoint/email — whatever fits HR's existing flow.
> - The file only needs the EMAIL NORTON team (8 people). Column spec in the attached template (`data/workday-absences.template.csv` in our repo).
> - Dashboard re-reads the file every 5 minutes, no restart needed when you update it.
>
> **Option B — iCal / ICS calendar feed (zero-touch once set up)**
>
> - If Workday can publish the team's absences as an iCal feed (many Workday tenants have this under *Time Off → Subscribe to calendar* or an HR-published team calendar), share the subscription URL with me and we can read from that directly.
> - Zero ongoing effort for HR after the initial setup. This is our strong preference if Workday supports it at Gen.
>
> **What's on the dashboard (privacy-safe):** we only surface "out today" and "out next 7 days" as the word "Vacation" to the general audience. The PTO type (sick, holiday, personal leave) and any notes are **only visible to team managers** inside a drill-down drawer — never on the public dashboard.
>
> **What's NOT on the dashboard:** dates from before today, reasons for medical absences, anything about compensation / contract / vacation balance. It's purely "is this person available to answer a Jira ticket right now, yes or no".
>
> Happy to jump on 15 minutes to walk through either option, and happy to take whatever format is easiest on your side — if you have an existing HR report that already includes this data, we can probably adapt to it.
>
> Thanks,
> Kevin Mold
> EMAIL NORTON CSM

---

## 📎 Attachment for the HR email — copy/paste block

Paste this at the bottom of the email as a **code block** so HR can see the exact columns:

```
slug,email,slackId,startDate,endDate,type,note
kristyna-simkova,,,2026-05-01,2026-05-08,PTO,Ibiza
jan-bartoncik,jan.bartoncik@gendigital.com,,2026-05-12,2026-05-12,Sick,
petr-studeny,,,2026-06-20,2026-07-04,PTO,Summer holiday
```

**Column rules:**


| Column      | Required?                           | Notes                                                                                                                            |
| ----------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `slug`      | Yes (one of slug / email / slackId) | The engineer-facing identifier we've pre-filled in the template. HR doesn't need to generate these — they live in `src/team.js`. |
| `email`     | Optional                            | If HR has corp email only (no Slack IDs, no slug knowledge), email alone is fine — we match on it.                               |
| `slackId`   | Optional                            | Only used when Slack is connected. `U…` format.                                                                                  |
| `startDate` | Yes if adding a row                 | `YYYY-MM-DD`, inclusive.                                                                                                         |
| `endDate`   | Yes if adding a row                 | `YYYY-MM-DD`, inclusive. Same as start for single-day absences.                                                                  |
| `type`      | Optional (default `PTO`)            | One of `PTO`, `Sick`, `Holiday`, `Personal`, `Leave`. Only visible to managers.                                                  |
| `note`      | Optional                            | Short free-form. Only visible to managers.                                                                                       |


Template file in the repo (pre-populated with the 8 roster slugs and detailed instructions): `data/workday-absences.template.csv`. Share the template as an attachment if HR wants a ready-to-fill starting point.

---

## ⚡ When the CSV arrives — 3-step apply

1. Save the file HR sent to `teampresence-slack/data/workday-absences.csv`
  (NOT `.template.csv` — leave that pristine for future HR handoffs).
2. Verify the dashboard picks it up (within 5 min, no restart required):
  ```bash
   KEY=$(awk -F= '/^DASHBOARD_KEY=/{print $2}' teampresence-slack/.env)
   curl -s "http://localhost:3000/api/absences?key=$KEY" | python3 -m json.tool
  ```
   Expect: an `absences` array reflecting exactly what HR put in the CSV.
3. Open the dashboard and check Team Presence + "Out next 7 days" — they should match.

If anyone is missing or showing the wrong day range, it's either a slug mismatch (check `src/team.js`) or a date format issue (it MUST be `YYYY-MM-DD` — not `DD/MM/YYYY` or `2026-5-1`).

**Gotchas observed in practice** (from the 2026-04-24 one-off delivery — fold these into the file before saving):

1. **Date locale.** Workday tenants configured for EU locale export dates as `DD/MM/YYYY`. The parser does string comparisons, so that shape silently breaks the "out today" check. Convert to `YYYY-MM-DD` before saving.
2. **Character encoding.** The raw Workday CSV can arrive as Windows-1252 with CRLF line endings, and some non-ASCII characters (notably Czech `č`) are replaced with a literal `?` on export. Re-save as UTF-8 (LF), and restore any mangled diacritics against `src/team.js` so the `findByName` matcher can hit the roster slug.
3. **Filename.** The landing file is canonically `data/workday-absences.<org>.csv` (e.g. `workday-absences.norton-email.csv`) with `WORKDAY_CSV_PATH` pointing at it. Don't overwrite `data/workday-absences.workday-native.csv` — that's the committed reference template used for CI / docs.

---

## ⚡ When the iCal feed arrives — 3-step apply

If HR came back with an iCal subscription URL:

1. Store the URL securely (it's essentially a read-only credential for your team's PTO):
  ```bash
   cd teampresence-slack
   # Edit .env manually with the URL (or add it via your preferred secret store):
   # WORKDAY_PROVIDER=ical
   # WORKDAY_ICAL_URL=https://workday.gendigital.com/ical/feed/...<token>
  ```
2. Restart:
  ```bash
   pkill -9 -f 'node src/index.js'
   PORT=3000 node src/index.js &
   sleep 3
   curl -s "http://localhost:3000/api/absences?key=$KEY" | python3 -m json.tool
  ```
3. No more manual CSV updates needed. Dashboard pulls the feed every 5 minutes.

---

## For HR's privacy / compliance review

If HR asks what we do with the data, the truthful answer:

- **Storage:** CSV / iCal is read into memory every 5 minutes. Nothing is persisted to a database, ever.
- **Transmission:** the absence file stays on the Gen Pulse server disk (`chmod 600`). Nothing leaves the server except the derived "X is on vacation" chips displayed to the team.
- **Retention:** the CSV / feed is re-read on every refresh; stale entries fall out of the dashboard automatically once their `endDate` passes.
- **Access:** only people who have access to the Gen Pulse dashboard (CSM team + managers + senior management) ever see any of this data. After Azure AD SSO is on (being set up separately — see `AZURE-AD-ADMIN-REQUEST.md`), access is governed by Azure AD group membership.
- **Audit trail:** the CSV is stored in the git repo **without** the `data/workday-absences.csv` file itself (that file is `.gitignore`'d). The template is tracked; live HR data is not.
- **No processing beyond derivation:** we don't email anyone about anyone's PTO, we don't rollup into HR metrics, we don't export. The data stays in one direction: Workday → CSV → dashboard chip.

If HR would prefer we use a role-gated Workday API endpoint (the Gen Digital Workday tenant may expose one), we can switch — the provider architecture in `src/presence/workday.js` supports `csv`, `ical`, and `rest` out of the box.