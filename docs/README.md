# Gen Pulse — Demo Build

This branch is **machine-generated**. Do NOT edit files here by hand.

It contains a fully static, sanitized snapshot of the live Gen Pulse
dashboard suitable for portfolio display on GitHub Pages.

Source repo (private): https://github.com/kentkong/gen-pulse-dashboard

## How it was built

```bash
npm run build:demo
# → dist/ contains the bundle pushed to this branch
```

See `DEMO.md` on the main branch for the full workflow.

## Sanitization guarantees

- All employee names replaced with deterministically-generated fakes
- All Slack user IDs replaced with `U_DEMO_*`
- All Jira issue keys replaced with `DEMO-*`
- All employee photos excluded from the bundle
- All private corporate hostnames in URLs replaced with `demo.example.com`
- Build refuses to publish if any real name leaks through
