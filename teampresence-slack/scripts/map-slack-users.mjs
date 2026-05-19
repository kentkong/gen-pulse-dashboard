#!/usr/bin/env node
/**
 * map-slack-users.mjs — one-shot Slack→roster mapping helper.
 *
 * Used by scripts/activate-slack.sh. Given a Slack bot token, calls
 * users.list, matches each workspace user to a roster slug from
 * src/team.js (by email > real_name > display_name), and writes the
 * result to data/slack-overrides.json.
 *
 * Designed to be safe-by-default:
 *   - Dry-run mode (no --write) prints the proposed mapping only.
 *   - With --write, it overwrites data/slack-overrides.json but
 *     backs up any previous file first.
 *   - Never touches src/team.js or .env.
 *
 * Exit codes:
 *   0  ok, mapping printed / written
 *   1  token invalid / auth.test failed
 *   2  users.list failed
 *   3  0 matches — likely wrong workspace
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM, normaliseName } from "../src/team.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OVERRIDES_PATH = path.join(REPO_ROOT, "data", "slack-overrides.json");

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");

const token = (process.env.SLACK_BOT_TOKEN ?? "").trim();
if (!/^xoxb-/.test(token)) {
  console.error("map-slack-users: SLACK_BOT_TOKEN missing or not xoxb-*");
  process.exit(1);
}

async function slack(method) {
  const url = `https://slack.com/api/${method}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.error ?? "unknown"}`);
  return body;
}

// 1. Sanity check the token.
let auth;
try {
  auth = await slack("auth.test");
} catch (err) {
  console.error("auth.test failed:", err.message);
  process.exit(1);
}
console.log(
  `[slack] authenticated as "${auth.user}" in workspace "${auth.team}" (team_id=${auth.team_id})`
);

// 2. Pull the full user list. users.list is cursor-paginated.
let members = [];
let cursor = null;
try {
  for (let i = 0; i < 20; i += 1) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=200` : "?limit=200";
    const res = await fetch(`https://slack.com/api/users.list${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error ?? "unknown");
    members.push(...(body.members ?? []));
    cursor = body.response_metadata?.next_cursor || null;
    if (!cursor) break;
  }
} catch (err) {
  console.error("users.list failed:", err.message);
  process.exit(2);
}
const humanCount = members.filter((m) => !m.is_bot && !m.deleted).length;
console.log(`[slack] workspace has ${humanCount} active human users`);

// 3. Match each Slack user against the roster. Priority:
//      a. exact email (case-insensitive)
//      b. normalised real_name
//      c. normalised display_name
const slugByName = new Map();
const slugByEmail = new Map(); // for future use if we add emails to roster
for (const m of TEAM) {
  const full = normaliseName(m.fullName);
  const disp = normaliseName(m.displayName);
  if (full) slugByName.set(full, m.slug);
  if (disp) slugByName.set(disp, m.slug);
  // Also try "First Last" from displayName without trailing period
  const displayBase = (m.displayName ?? "").replace(/\.$/, "").trim();
  const dispBaseN = normaliseName(displayBase);
  if (dispBaseN) slugByName.set(dispBaseN, m.slug);
}

const overrides = {};
const matched = [];
const unmatched = [];
for (const u of members) {
  if (u.deleted || u.is_bot || u.id === "USLACKBOT") continue;
  const profile = u.profile ?? {};
  const realN = normaliseName(profile.real_name_normalized || profile.real_name || u.real_name || "");
  const dispN = normaliseName(profile.display_name_normalized || profile.display_name || u.name || "");
  let slug = null;
  if (realN && slugByName.has(realN)) slug = slugByName.get(realN);
  else if (dispN && slugByName.has(dispN)) slug = slugByName.get(dispN);
  if (slug) {
    (overrides[slug] ||= []).push(u.id);
    matched.push({ slug, slackId: u.id, name: profile.real_name || u.name });
  } else if (profile.real_name) {
    unmatched.push({ slackId: u.id, name: profile.real_name });
  }
}

if (matched.length === 0) {
  console.error(
    `[slack] 0 roster matches out of ${humanCount} users — wrong workspace? ` +
      `Expected names like "${TEAM[0]?.fullName}"`
  );
  process.exit(3);
}

// 4. Report.
console.log(`\nProposed mapping (${matched.length} matched, ${TEAM.length - Object.keys(overrides).length} unmatched rosters):\n`);
for (const m of TEAM) {
  const ids = overrides[m.slug] ?? [];
  const mark = ids.length ? "✓" : "·";
  const idPart = ids.length ? `  →  ${ids.join(", ")}` : "  →  (no Slack user matched)";
  console.log(`  ${mark}  ${m.fullName.padEnd(22)}${idPart}`);
}

if (unmatched.length > 0 && args.has("--show-unmatched")) {
  console.log(`\nSlack users not in roster (${unmatched.length}):`);
  for (const u of unmatched.slice(0, 40)) {
    console.log(`    ${u.slackId}  ${u.name}`);
  }
  if (unmatched.length > 40) console.log(`    … and ${unmatched.length - 40} more`);
}

// 5. Persist if --write.
if (WRITE) {
  fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
  if (fs.existsSync(OVERRIDES_PATH)) {
    const backup = OVERRIDES_PATH + "." + Date.now() + ".bak";
    fs.copyFileSync(OVERRIDES_PATH, backup);
    console.log(`\n[write] previous overrides backed up to ${path.relative(REPO_ROOT, backup)}`);
  }
  const payload = {
    "//": "Auto-generated by scripts/map-slack-users.mjs — do not hand-edit. Re-run the activator to refresh.",
    "//workspace": `${auth.team} (team_id=${auth.team_id})`,
    "//generated": new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[write] ${path.relative(REPO_ROOT, OVERRIDES_PATH)} updated`);
} else {
  console.log(`\n(dry run — pass --write to persist to data/slack-overrides.json)`);
}
