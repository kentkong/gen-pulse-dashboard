# Gen Pulse — Portfolio / Interview Demo Build

Turn the live Gen Pulse dashboard into a fully static, anonymised
version that you can share as a public GitHub Pages URL.

## TL;DR — three commands

```bash
cd teampresence-slack
npm run demo:build           # builds dist/ from mock data, no live server needed
npm run demo:serve           # → http://localhost:4173 — preview before pushing
```

That's it. No live server, no cookie, no Jira/Slack/Workday tokens
needed. The build script boots `src/preview.js` in the background
(which already ships hardcoded mock data for every endpoint),
snapshots from it, deterministically anonymises everything, and
outputs `dist/`.

After verifying it looks right, jump to **"Push to GitHub Pages"**
below.

## What gets sanitized

| Live data | Demo data |
| --- | --- |
| Real names (Daniel Žabenský, Anna Aldüz, …) | Fake names from a 1024-combo pool, deterministic per-person |
| Slack user IDs (`U08V5F1RX6U`) | `U_DEMO_<hex>` |
| Jira keys (`EMOPS-1234`) | `DEMO-1234` (number preserved) |
| Ticket summaries / descriptions | Curated generic email-marketing tasks |
| Slack status text | "In meetings" / "Heads-down" / "On a call" / etc. |
| Workday absence notes | "Annual leave" / "Public holiday" / etc. |
| Avatar URLs (Slack edge CDN, Jira corp host, /team/\*.png) | `null` — frontend's initials-fallback renders instead |
| Email addresses | `firstname.lastname@example.com` |
| Initials | Recomputed from the fake name (so "DŽ" doesn't survive) |
| Corporate hostnames in URLs | `demo.example.com` |

The sanitizer **refuses** to write `dist/data/` if any real name
lingers in the output, so a missing roster mapping fails the build
loudly rather than leaking silently.

## What is preserved

- Numbers and aggregates (backlog count, throughput, sprint stats) —
  these tell the dashboard's story and aren't PII
- Status categories (Done, In Progress, To Do, PTO, Sick, …)
- Widget shapes, colours, layout — the demo looks identical to prod
- Brand identity (Gen Pulse name, Norton/AVAST logos, theme)

## Push to GitHub Pages

```bash
# ONE-TIME setup — create the demo branch with no history
cd teampresence-slack
git checkout --orphan demo
git rm -rf .
git commit --allow-empty -m "demo branch — populated by scripts/build-demo.mjs"
git push origin demo
git checkout main

# ONE-TIME — set up a worktree so dist/ syncs cleanly to the demo branch
git worktree add ../gen-pulse-demo demo
```

Now every time you want to refresh the public demo:

```bash
# 1. Build (from the main worktree)
cd teampresence-slack
npm run demo:build

# 2. Sync dist/ → demo worktree (rsync removes stale files too)
rsync -a --delete dist/ ../gen-pulse-demo/

# 3. Commit + push the demo worktree
cd ../gen-pulse-demo
git add -A
git commit -m "demo build $(date +%Y-%m-%d)"
git push origin demo
```

## Enable GitHub Pages — one-time, in the browser

1. Open <https://github.com/kentkong/gen-pulse-dashboard/settings/pages>
2. Under **Build and deployment**:
   - **Source**: Deploy from a branch
   - **Branch**: `demo` / `/ (root)`
3. Click **Save**.
4. After ~30 seconds, the page shows
   `Your site is live at https://kentkong.github.io/gen-pulse-dashboard/`

That URL is what you share in interviews, on a portfolio page, or
paste into a screening email. The repo can stay private — GitHub
Pages serves the files publicly even from a private repo (only the
contents of the `demo` branch are visible).

## Privacy review checklist

Before you push the first time, **manually** confirm:

- [ ] `dist/team/` does not exist (no real employee photos)
- [ ] `dist/.env` does not exist (no secrets)
- [ ] Open `dist/data/_meta.json` — every name listed should sound
      generic (Alex, Jordan, Sam, …), nothing recognisable
- [ ] Open the local preview at `localhost:4173`, hit DevTools →
      Network → reload — every request should be to `localhost:4173`
      or local `data/*.json`. Zero traffic to corporate hosts
      (`gendigital.com`, `slack.com`, `nortonlifelock.com`,
      `microsoftonline.com`, `atlassian.net`)
- [ ] Run a leak grep:
      ```
      grep -ri "Žabenský\|Aldüz\|Královcová\|nortonlifelock\|gendigital\.com\|slack-edge" dist/
      ```
      Should return nothing.

If any check fails, **don't push**. Fix the leak in
`scripts/sanitize-demo.mjs`, rebuild, and check again.

## Two build modes — when to use which

```bash
npm run demo:build          # MOCK MODE (recommended)
                            # Uses src/preview.js, no live deps.
                            # Fastest, simplest, no auth needed.

npm run demo:build:live -- --cookie "$GP_SESSION"
                            # LIVE MODE
                            # Snapshots from a running localhost:3000
                            # with real Jira/Slack/Workday data.
                            # Use this when you want the demo to
                            # mirror your most-recent production
                            # numbers (e.g. before an exec review).
```

Both modes go through the same sanitizer with the same leak guards —
the only difference is the data source. For interview / portfolio
purposes, **mock mode is the right answer**: faster to refresh,
zero secrets involved, identical UI fidelity.

## Editing the fake data by hand

If you want to tweak names / numbers / tickets after a build (e.g.
to match a story you want to tell in an interview), the easiest
edit point is `dist/data/`. Each `.json` file maps 1:1 to a frontend
widget's `/api/...` endpoint. Re-running `npm run demo:serve` after
editing reflects changes instantly — no rebuild needed.

To make those edits permanent (so they survive a `demo:build`),
add them to the `FAKE_TICKET_SUMMARIES` / `FAKE_NOTES` /
`FAKE_STATUS_TEXTS` pools in `scripts/sanitize-demo.mjs`, or curate
the seed data in `src/preview.js`.

## Talking points for interviews

A few aspects of this build worth highlighting if asked:

- **Single-choke-point fetch interception** — the demo shim patches
  `window.fetch` before any other JS runs, so a 12-widget dashboard
  becomes static-deployable with ~150 lines of patch code and zero
  changes to the original frontend
- **Deterministic anonymisation** — same real person always maps to
  the same fake person across all widgets, so the demo data tells a
  consistent story (e.g. "Alex Bennett is consistently the top
  performer in the leaderboard, the team grid, and the kanban
  assignee column")
- **Build-fails-on-leak invariant** — the sanitizer's
  `verifyNoLeaks()` pass turns "did I forget anyone?" from a
  human-eyeball problem into a CI-level guarantee, including
  edge cases like 2-character diacritic initials
- **`.nojekyll`** — small detail, but GitHub Pages would otherwise
  silently strip `_meta.json`; one-byte file saves a confusing
  debugging session
