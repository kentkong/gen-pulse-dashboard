# Slack workspace admin — app approval request

This doc is a ready-to-forward template for the Slack workspace admin at Gen Digital. Copy the email body below, fill in the **[bracketed]** fields, send.

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
  - `users:read` → https://api.slack.com/scopes/users:read
  - `users.profile:read` → https://api.slack.com/scopes/users.profile:read
  - `users:read.presence` → https://api.slack.com/scopes/users:read.presence
- The presence-mapping code that owns status parsing: `src/presence/slack-status.js`, `src/presence/mapping.js`
