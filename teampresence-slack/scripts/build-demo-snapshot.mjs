#!/usr/bin/env node
/**
 * build-demo-snapshot.mjs
 *
 * Captures a point-in-time snapshot of every public Gen Pulse API
 * response and saves it to disk as raw JSON, ready to be sanitized
 * for the offline / portfolio static build.
 *
 * Why we need this for the demo build
 * ===================================
 * Gen Pulse is a live SaaS dashboard backed by Jira, Slack, Workday,
 * and Azure AD SSO. None of those services are available to a
 * recruiter clicking a public GitHub Pages URL. The portfolio version
 * therefore swaps the live `/api/*` calls for static JSON files baked
 * into the bundle. This script produces those JSON files.
 *
 * It is intentionally read-only and assumes the user has the real
 * server running locally with real credentials. We do NOT re-implement
 * widget logic here — we just capture what the server actually returns
 * for each endpoint × team combination, exactly as the production UI
 * sees it. That keeps the demo's data shape 100% in sync with the
 * live app and means new widgets get picked up automatically the next
 * time someone re-runs this script.
 *
 * Usage
 * -----
 *   1. Start the dashboard locally so it's serving with real data:
 *        npm start                                # AUTH_STRATEGY=oidc
 *      …or, if Azure AD is unavailable, in mock mode:
 *        AUTH_STRATEGY=mock-oidc OIDC_MOCK_ALLOW=true npm start
 *
 *   2. Sign in via the browser at http://localhost:3000.
 *
 *   3. Open DevTools → Application → Cookies → http://localhost:3000.
 *      Copy the value of the `gp_session` cookie (mock + real OIDC
 *      use the same cookie name).
 *
 *   4. Run this script with the cookie:
 *        node scripts/build-demo-snapshot.mjs --cookie "$GP_SESSION"
 *
 *      Or paste the cookie via stdin to avoid shell history:
 *        echo "$GP_SESSION" | node scripts/build-demo-snapshot.mjs --cookie -
 *
 * Output
 * ------
 *   tmp/snapshot-raw/
 *     ├── manifest.json                   # what was captured + when
 *     ├── norton/
 *     │   ├── team.json
 *     │   ├── absences.json
 *     │   ├── widgets.json                # widget catalog
 *     │   ├── widgets/<widget-id>.json    # one per widget
 *     │   ├── jira-projects.json
 *     │   └── weather.json
 *     └── avast/
 *         └── …                           # same shape
 *
 * The output goes to tmp/ (gitignored) deliberately — these JSON files
 * still contain real names / Jira keys / Slack IDs and MUST be passed
 * through scripts/sanitize-demo.mjs before anything is committed or
 * pushed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(PROJECT_ROOT, "tmp", "snapshot-raw");

// Endpoints we capture per team. Keep this in lockstep with the
// `apiUrl()` callsites in public/index.html — when a new widget loader
// is added there, mirror it here so the demo build picks it up.
//
// `slug` is the on-disk filename (no .json extension).
// `path` is the URL path (no query string — we add ?team=… ourselves).
const TEAM_ENDPOINTS = [
  { slug: "team", path: "/api/team" },
  { slug: "absences", path: "/api/absences", query: { days: "7" } },
  { slug: "widgets", path: "/api/widgets" }, // widget catalog
  { slug: "jira-projects", path: "/api/jira-projects" },
  { slug: "weather", path: "/api/weather" },
];

// Each widget has its own endpoint at /api/widgets/<id>. We could read
// /api/widgets to discover them dynamically, but listing them
// explicitly keeps the snapshot deterministic and means a buggy widget
// catalog doesn't silently drop endpoints from the demo bundle.
const WIDGET_IDS = [
  "weekly-throughput",
  "backlog-overview",
  "ticket-lifecycle",
  "inflow-vs-resolved",
  "sla-aging-risk",
  "sprint-backlog",
  "reopen-rate",
  "throughput-leaderboard",
  "top-priority-tickets",
  "kanban-board",
];

const TEAMS = ["norton", "avast"];

function parseArgs(argv) {
  const args = { baseUrl: "http://localhost:3000", cookie: null, key: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--cookie") args.cookie = argv[++i];
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/build-demo-snapshot.mjs [--base-url URL] [--cookie VALUE|-] [--key DASHBOARD_KEY]"
      );
      process.exit(0);
    }
  }
  return args;
}

async function maybeReadCookieFromStdin(args) {
  if (args.cookie !== "-") return args;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  args.cookie = Buffer.concat(chunks).toString("utf8").trim();
  return args;
}

function buildHeaders({ cookie }) {
  const h = { Accept: "application/json" };
  if (cookie) {
    // Accept either the bare gp_session value or a full Cookie header
    // (the latter is what users paste from DevTools' "copy as cURL").
    h.Cookie = cookie.includes("=") ? cookie : `gp_session=${cookie}`;
  }
  return h;
}

function buildUrl(baseUrl, endpointPath, { team, key, query }) {
  const u = new URL(endpointPath, baseUrl);
  if (team) u.searchParams.set("team", team);
  if (query) {
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  }
  if (key) u.searchParams.set("key", key);
  return u.toString();
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, redirect: "manual" });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, status: res.status, error: "non-json", body: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, json };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function snapshotTeam({ team, baseUrl, headers, key, summary }) {
  const teamDir = path.join(RAW_DIR, team);
  for (const ep of TEAM_ENDPOINTS) {
    const url = buildUrl(baseUrl, ep.path, { team, key, query: ep.query });
    const r = await fetchJson(url, headers);
    const file = path.join(teamDir, `${ep.slug}.json`);
    if (!r.ok) {
      // 404 is a soft failure — the source server simply doesn't
      // implement that endpoint. Common cases: preview.js doesn't
      // ship /api/weather, older builds before /api/jira-projects
      // existed. The demo shim translates a missing file into the
      // same "unavailable" empty state the live frontend already
      // renders, so a 404 here is functionally identical to a
      // working endpoint that returned no data — not a build break.
      if (r.status === 404) {
        await writeJson(file, { unavailable: true, reason: "endpoint-not-implemented" });
        summary.captured.push({ team, slug: ep.slug, soft: true });
        console.log(`  ⚠ ${team}/${ep.slug}  (HTTP 404 → saved unavailable stub)`);
        continue;
      }
      summary.failures.push({ team, slug: ep.slug, status: r.status, url });
      console.warn(`  ✗ ${team}/${ep.slug}  HTTP ${r.status}  ${url}`);
      continue;
    }
    await writeJson(file, r.json);
    summary.captured.push({ team, slug: ep.slug });
    console.log(`  ✓ ${team}/${ep.slug}`);
  }
  for (const wid of WIDGET_IDS) {
    const url = buildUrl(baseUrl, `/api/widgets/${wid}`, { team, key });
    const r = await fetchJson(url, headers);
    const file = path.join(teamDir, "widgets", `${wid}.json`);
    if (!r.ok) {
      // Widget endpoints can legitimately return 503 / 200 with
      // {unavailable:true} when an upstream (Jira) is throttled. We
      // still save the body so the demo can render the same "data
      // unavailable" empty state the live app shows.
      if (r.status === 503 || r.status === 500) {
        await writeJson(file, r.json ?? { unavailable: true });
        summary.captured.push({ team, slug: `widgets/${wid}`, soft: true });
        console.log(`  ⚠ ${team}/widgets/${wid}  (HTTP ${r.status} → saved unavailable stub)`);
        continue;
      }
      summary.failures.push({ team, slug: `widgets/${wid}`, status: r.status, url });
      console.warn(`  ✗ ${team}/widgets/${wid}  HTTP ${r.status}`);
      continue;
    }
    await writeJson(file, r.json);
    summary.captured.push({ team, slug: `widgets/${wid}` });
    console.log(`  ✓ ${team}/widgets/${wid}`);
  }
}

async function main() {
  let args = parseArgs(process.argv);
  args = await maybeReadCookieFromStdin(args);

  if (!args.cookie && !args.key) {
    console.error(
      "Refusing to run without auth. Pass --cookie <gp_session value> " +
        "(get it from DevTools → Application → Cookies on a logged-in " +
        "browser session) or --key <DASHBOARD_KEY> if shared-key auth " +
        "is enabled on the running server."
    );
    process.exit(2);
  }

  console.log(`[snapshot] base = ${args.baseUrl}`);
  console.log(`[snapshot] auth = ${args.cookie ? "cookie" : "shared-key"}`);

  // Fail fast if the server isn't reachable. /healthz is unauth and
  // tiny — it short-circuits the "did the user forget to npm start?"
  // failure mode with a useful message.
  try {
    const ping = await fetch(new URL("/healthz", args.baseUrl).toString());
    if (!ping.ok) throw new Error(`/healthz returned HTTP ${ping.status}`);
  } catch (err) {
    console.error(
      `[snapshot] cannot reach ${args.baseUrl} — is the dashboard running?\n  ${err?.message ?? err}`
    );
    process.exit(3);
  }

  // Wipe previous snapshot to avoid stale endpoints lingering when the
  // widget catalog shrinks. tmp/ is gitignored so this is safe.
  await fs.rm(RAW_DIR, { recursive: true, force: true });
  await ensureDir(RAW_DIR);

  const headers = buildHeaders(args);
  const summary = { captured: [], failures: [], at: new Date().toISOString() };

  for (const team of TEAMS) {
    console.log(`\n[snapshot] team=${team}`);
    await snapshotTeam({ team, baseUrl: args.baseUrl, headers, key: args.key, summary });
  }

  await writeJson(path.join(RAW_DIR, "manifest.json"), {
    capturedAt: summary.at,
    baseUrl: args.baseUrl,
    teams: TEAMS,
    endpoints: TEAM_ENDPOINTS.map((e) => e.slug),
    widgets: WIDGET_IDS,
    counts: {
      captured: summary.captured.length,
      failed: summary.failures.length,
    },
    failures: summary.failures,
  });

  console.log(
    `\n[snapshot] done. captured=${summary.captured.length} failed=${summary.failures.length}`
  );
  console.log(`[snapshot] raw output → ${path.relative(PROJECT_ROOT, RAW_DIR)}/`);
  console.log(`[snapshot] next step → node scripts/sanitize-demo.mjs`);

  // Exit with code 1 if anything failed so CI / orchestrator scripts
  // notice. Soft failures (503 captured as unavailable stub) are
  // counted as captured, not failed.
  if (summary.failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[snapshot] fatal:", err);
  process.exit(99);
});
