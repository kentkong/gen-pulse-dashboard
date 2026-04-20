# Team Presence (Slack)

Small Slack app you host on **any HTTPS domain** (your “general” or internal hostname). It gives your team:

- **`/teampresence away …`** — store where they are (meeting, travel, focus) with optional **until** time.
- **`/teampresence here`** — mark available again.
- **`/teampresence roster`** (run **in a channel**) — list channel members and what they last saved.
- **`/teampresence rollcall "Meeting"`** — posts **Attending / Late / Absent** buttons; responses are stored.
- **`/teampresence missed <id>`** — channel members who have **not** clicked any button yet for that roll call.

Data is stored in **SQLite** (`DATABASE_PATH`, default `./data/teampresence.db`).

## Slack setup

1. Create an app: [Slack API: Your Apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** (or paste pieces from `slack-manifest.json`).
2. Replace every `https://YOUR_DOMAIN` in the manifest with your public URL, e.g. `https://presence.company.com`.
3. **OAuth & Permissions** → install to workspace → copy **Bot User OAuth Token** → `SLACK_BOT_TOKEN`.
4. **Basic Information** → **Signing Secret** → `SLACK_SIGNING_SECRET`.
5. Under **Slash Commands** and **Interactivity**, set the **Request URL** to `https://YOUR_DOMAIN/slack/events` (same path for both; Bolt handles it).
6. **Install** the app to the workspace and **invite the bot** to channels where you use roll calls or roster.

### Bot token scopes

`channels:read`, `groups:read`, `chat:write`, `commands`, `users:read`

## Run locally (Socket Mode, no public URL)

1. Enable **Socket Mode** on the app and create an **App-Level Token** with `connections:write` → `SLACK_APP_TOKEN`.
2. `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_SOCKET_MODE=true
SLACK_APP_TOKEN=xapp-...
```

3. `npm install` then `npm start`.

## Run on your domain (HTTP mode)

1. Keep **Socket Mode** off.
2. Serve **HTTPS** to the internet (reverse proxy or PaaS). Set `PORT` if the host requires it.
3. `.env`: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` only (no app token).
4. Point Slack **Request URLs** at `https://YOUR_DOMAIN/slack/events`.

Docker: build and run the image; mount a volume on `/app/data` if you want the DB to persist.

## Admin list (optional)

Set `TEAMPRESENCE_ADMIN_USER_IDS` to a comma-separated list of Slack user IDs. If empty, **everyone** can start roll calls and run `missed` (fine only for trusted small teams).

## Limits

- “Missed” is **missed roll-call button response**, not automatic calendar or Zoom attendance.
- Roster reads **saved** presence; it does not read Slack’s live status emoji.
