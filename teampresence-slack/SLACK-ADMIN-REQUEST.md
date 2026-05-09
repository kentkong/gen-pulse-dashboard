# Slack workspace admin — app approval request

> **Status (2026-04-26 PM): ✅ APPROVED — pending token retrieval.**
> RITM0213806 received both approvals on 2026-04-26:
>
> - **Petr Šilhan** (app owner) — "I have approved the application for
> installation." (sent via Slack-side approval path.)
> - **Rob Ryan** (workspace admin / senior approver) — "I approve the
> request." (ServiceNow approver chain, ref `MSG7711702_TRc8EWEzUeCNfXTb9Psu`.)
>
> **Immediate next action (Kevin):** go to `api.slack.com/apps` →
> **Gen Pulse** → **Install App** — the "Install to Workspace" button
> should now complete. Copy `Bot User OAuth Token` (`xoxb-…`) and the
> `Signing Secret` from **Basic Information**. Then run:
>
> ```
> ./scripts/activate-slack.sh
> ```
>
> This one command writes the tokens to `.env`, flips
> `PRESENCE_MODEL=slack+workday`, maps the 8 roster people to their
> Slack IDs via `users.list`, and restarts the server. See
> `GO-LIVE-RUNBOOK.md` Step 3b for the full breakdown.
>
> **Original filing (2026-04-24 PM):** App created in the Gen
> workspace, collaborator added, scopes configured, install request
> submitted and visible to the admin.
>
> **Completed on 2026-04-24 (Kevin):**
>
> - Created "Gen Pulse" as a "From scratch" app in the **Gen**
> workspace (not "Gen External" — that's for partners).
> - Added `svc.slack.appadm` as a collaborator on the app.
> - Replied to the admin with the App ID and workspace context.
> - Configured bot-token scopes (see table below).
> - Submitted **Request to Install** to the Gen workspace. First
> attempt failed with a generic "Try again later" error — resolved
> on the second attempt after the admin enabled install requests
> on their side. Admin can now see the request.
>
> **App metadata (non-secret, safe to share in tickets):**
>
>
> | Field            | Value                              |
> | ---------------- | ---------------------------------- |
> | App Name         | `Gen Pulse`                        |
> | App ID           | `A0AUY7JRG5T`                      |
> | Dev workspace    | `Gen` (Gen Digital Inc)            |
> | Created          | 2026-04-24                         |
> | Collaborators    | `Kevin Mold`, `svc.slack.appadm`   |
> | Bot-token scopes | `users:read`, `users.profile:read` |
>
>
> **Scope-count deviation from the original request — intentional:**
> the original ticket named three scopes
> (`users:read`, `users.profile:read`, `users:read.presence`). Modern
> (OAuth v2) Slack bot apps no longer expose `users:read.presence` as
> a separate scope — presence is bundled into `users:read`. The
> two-scope set is the correct final configuration for our read-only
> presence use case, with no loss of functionality.
>
> **Still pending (admin side):** approval of the install request.
> On approval we receive `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`
> (and optionally `SLACK_APP_TOKEN` for Socket Mode). When those
> land, follow the 3-step checklist below. Tracked against the Slack
> integration milestone in `GO-LIVE-RUNBOOK.md` Step 3a.
>
> **Do not paste `Client Secret`, `Signing Secret`, or
> `SLACK_BOT_TOKEN` into this repo or into chat.** Only `App ID`,
> `Client ID`, scope names, and the app name are safe to share.

This doc is a ready-to-forward template for the Slack workspace admin at Gen Digital. Copy the email body below, fill in the **[bracketed]** fields, send.

---

## ⚡ When you're ready to turn Slack ON (3-step checklist)

Use this once the workspace admin has approved the app and given you the tokens. Expected time: 10 minutes end-to-end.

### Step 1 — create the Slack app at [https://api.slack.com/apps](https://api.slack.com/apps)

1. Click **Create New App** → **From scratch**.
2. App Name: `Gen Pulse`. Workspace: `Gen Digital`.
3. Under **OAuth & Permissions → Bot Token Scopes**, add exactly three:
  - `users:read`
  - `users.profile:read`
  - `users:read.presence`
4. Click **Install to Workspace** → this is the point where workspace admin approval is required (see email template below).
5. Once approved, copy the **Bot User OAuth Token** — starts with `xoxb-`.
6. From **Basic Information → App Credentials**, copy the **Signing Secret**.

### Step 2 — run the one-shot activator

```bash
cd teampresence-slack
./scripts/activate-slack.sh
```

It prompts (hidden input) for `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `SLACK_APP_TOKEN` (optional — only if Socket Mode is wanted), then in one pass:

1. Verifies the bot token with `auth.test` **before touching anything**.
2. Backs up `.env` to `.env.<timestamp>.bak`.
3. Writes the three env vars + flips `PRESENCE_MODEL=slack+workday`.
4. Calls `scripts/map-slack-users.mjs --write` to build `data/slack-overrides.json` (slug → Slack ID mapping, gitignored) by calling `users.list` and name-matching the roster.
5. Restarts the server on :3000.
6. Smoke-tests `/api/team` and prints `members=8 slack-driven=N live-avatars=N`.

Never paste tokens into chat / git / this repo. The activator reads them from stdin and the `.env` file is gitignored.

### Step 3 — manual verification in the UI

Open the dashboard, check Team Presence:

- Green / away dots next to each of the 8 people match their live Slack state.
- Profile photos switch from the local `/team/<slug>.png` fallbacks to real Slack avatars.
- Changing your own Slack status to "🏖️ On vacation" flips your Gen Pulse card to "Vacation" within ~60 seconds.

If fewer than 8 resolve, fill in the missing `slackIds: [...]` in `src/team.js` for roster members the bot hasn't seen yet — you can find their IDs in the Slack admin directory or by clicking "View profile → More → Copy member ID".

---

## Email template

**To:** `[Slack workspace admin distro]` *(usually IT / collab-tools team)*
**Cc:** `[your manager]`, `[scrum master]`, `[Gen Pulse lead dev]`
**Subject:** Slack app install approval — "Gen Pulse" (EMAIL NORTON / Customer Success)

> Hi team,
>
> I'd like to request approval to install a new internal Slack app, **Gen Pulse**, in the Gen Digital Slack workspace, starting with the EMAIL NORTON / Customer Success rooms.
>
> **What it is**
> Gen Pulse is an internal mobile-first operational dashboard for CSM teams — a single place to see Jira throughput, SLAs, sprint backlog, workday vacations, and team presence in real time. It's been reviewed with `[senior manager name]` and we're now moving it from demo-grade to production-ready.
>
> **What the Slack integration does**
> Gen Pulse reads user **profile** and **presence** data for roster members so the "Team Presence" widget can show live status (in office / WFH / in a meeting / away / on vacation) based on each person's own Slack status. No messages are read or sent in this mode. There are no slash commands, no bots in channels, and no DMs.
>
> **Required bot scopes** (exact Slack scope names):
>
> - `users:read` — list roster members + fetch display name, photo
> - `users.profile:read` — read status text + status emoji + custom fields set by each user
> - `users:read.presence` — read auto-presence (active / away)
>
> *We are **NOT** requesting* `chat:write`, `im:write`, `im:history`, or anything that reads message content.
>
> **Who will see it**
> Initial rollout: the EMAIL NORTON team (~8 people). If the pilot is well-received, next rollout is senior directors in the same org, then a wider customer-success rollout. All further stages will come back for separate approval.
>
> **Hosting**
> `[Azure / AWS / on-prem — TBD with IT]`. The app reads from Slack, Jira, and Workday; writes to nothing. Access is gated by `[Azure AD SSO once stood up / pre-shared dashboard key in the interim]`.
>
> **Data handling**
>
> - No message content is read or stored.
> - Profile fields (name, photo, status text, auto-presence) are held in-memory only, TTL 5 minutes, never written to disk.
> - The dashboard is only accessible on the corporate network (and/or via SSO-gated proxy, once stood up).
>
> **Admin verification**
> Happy to jump on a call or share the code for review — the relevant integration lives in `src/presence/slack-status.js` and the scope list is pinned in `.env.example`. Everything is behind a feature flag (`PRESENCE_MODEL=slack`) that falls back to a safe "no-Slack" mode if the app is disabled.
>
> Let me know what other info you need to process the request. Happy to present it to the collab-tools weekly if that's the right forum.
>
> Thanks,
> `[your name]`

---

## FAQ the admin might ask (have answers ready)

**Q. Why not use the existing Slack analytics / enterprise workflows?**
A. We need per-user real-time status in a mobile dashboard for the CSM team — existing admin analytics are aggregate and after-the-fact.

**Q. Will the app post anything into Slack?**
A. Not in this scope. The only out-of-band alert we've discussed is an optional weekly-throughput digest to a single reports channel; if approved, that needs `chat:write` as a separate follow-up and goes to one channel you nominate.

**Q. Is profile data stored anywhere?**
A. In-memory only, with a 5-minute TTL. Nothing is persisted to disk, logs, or a database. Code reference: `src/presence/slack-status.js`.

**Q. Can users opt out?**
A. Yes — any team member can set their Slack status to a keyword (e.g. `:hide:` or a custom emoji we configure in `presence/mapping.js`) and Gen Pulse will mask it as "Unknown" for that user, still respecting their opt-out preference centrally.

**Q. What about GDPR / data protection?**
A. No new personal data is collected — we read what the user has already published to their Slack profile. We've flagged it with the DPO for review before production rollout.

**Q. What happens if we revoke access?**
A. Gen Pulse automatically falls back to "Web-only" mode — the dashboard still works, the Team Presence widget just shows "Unknown" for everyone until Slack is reconnected. No crashes, no hangs, no log flood.

---

## Technical follow-up the admin will need to send back

Once approved, the admin will give you **three** values:

1. `SLACK_BOT_TOKEN=xoxb-...` — the app's OAuth bot token.
2. `SLACK_SIGNING_SECRET=...` — for verifying inbound requests (mostly cosmetic for our read-only use, but Bolt requires it).
3. *(Optional)* `SLACK_APP_TOKEN=xapp-...` — only needed if we use Socket Mode (no public URL). Recommended in the pilot stage.

Put these into `.env`, restart the server, and flip `PRESENCE_MODEL=slack` or `PRESENCE_MODEL=slack+workday` to activate.

---

## Useful links to include in the email

- Slack scope documentation:
  - `users:read` → [https://api.slack.com/scopes/users:read](https://api.slack.com/scopes/users:read)
  - `users.profile:read` → [https://api.slack.com/scopes/users.profile:read](https://api.slack.com/scopes/users.profile:read)
  - `users:read.presence` → [https://api.slack.com/scopes/users:read.presence](https://api.slack.com/scopes/users:read.presence)
- The presence-mapping code that owns status parsing: `src/presence/slack-status.js`, `src/presence/mapping.js`

