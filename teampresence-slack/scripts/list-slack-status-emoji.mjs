// =============================================================================
// list-slack-status-emoji.mjs
// -----------------------------------------------------------------------------
// Diagnostic + curation helper for the Slack-status emoji glyph map in
// public/index.html. Asks: "What emoji shortcodes is the team actually
// using right now, and are any of them not yet in SLACK_EMOJI_MAP?"
//
// What it does:
//   1. Loads .env (just to pick up SLACK_BOT_TOKEN and the roster
//      overrides path — same pattern as probe-sprint-backlog.mjs).
//   2. Reads the TEAM roster + data/slack-overrides.json so we hit every
//      member who has a Slack id wired up.
//   3. Calls users.profile.get for each of them in parallel (with
//      Promise.allSettled so one bad scope can't kill the run).
//   4. Greps the current SLACK_EMOJI_MAP out of public/index.html so we
//      don't have to maintain the list in two places.
//   5. Prints three sections:
//        - "Currently in use"   : every shortcode + which member set it
//        - "Already mapped"     : the ones that will render as glyphs
//        - "MISSING — add these": copy-paste-ready map entries for any
//                                 shortcode that's in use but not yet
//                                 in SLACK_EMOJI_MAP. We include a
//                                 best-guess glyph from a fallback
//                                 lookup table when we have one, and
//                                 leave a "TODO glyph" placeholder
//                                 otherwise so the operator can fill
//                                 it in.
//
// Read-only against Slack and against the codebase. Run before a demo
// when you want to make sure no team member's status will render as a
// muted dot.
//
// Usage:
//   node scripts/list-slack-status-emoji.mjs
//
// Requires:
//   - SLACK_BOT_TOKEN in .env (with users:read and users.profile:read)
//   - data/slack-overrides.json populated (or roster entries with
//     hard-coded slackIds)
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import { TEAM } from "../src/team.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const INDEX_HTML = path.join(REPO_ROOT, "public", "index.html");
const OVERRIDES_PATH = path.join(REPO_ROOT, "data", "slack-overrides.json");

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

/**
 * Load .env into process.env without pulling in dotenv. Same approach as
 * probe-sprint-backlog.mjs — keeps this script dependency-free.
 */
function loadEnv() {
  let raw;
  try {
    raw = readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes a `KEY="value with spaces"` would leave.
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

/**
 * Pull SLACK_EMOJI_MAP out of public/index.html. We extract the JS
 * object literal as text and eval it inside a tiny sandbox so we
 * don't have to copy/maintain the same list in two places. The
 * pattern is anchored by the `const SLACK_EMOJI_MAP = {` opener and
 * the matching closing `};` immediately preceding the helper
 * function — both are stable landmarks the file has comments
 * pinning in place.
 */
function readMappedShortcodes() {
  const html = readFileSync(INDEX_HTML, "utf8");
  const start = html.indexOf("const SLACK_EMOJI_MAP = {");
  if (start < 0) {
    throw new Error(
      `[list-slack-status-emoji] couldn't find SLACK_EMOJI_MAP in ${INDEX_HTML} — has the symbol been renamed?`
    );
  }
  const end = html.indexOf("};", start);
  if (end < 0) throw new Error("[list-slack-status-emoji] unterminated SLACK_EMOJI_MAP");
  // The text between `{` and `}` is the body. eval'ing the literal
  // is safe because the file is part of our own source tree and the
  // contents of this map are quoted strings only.
  const objLiteral = html.slice(start + "const SLACK_EMOJI_MAP =".length, end + 1);
  // eslint-disable-next-line no-new-func
  const map = Function(`"use strict"; return (${objLiteral})`)();
  if (!map || typeof map !== "object") {
    throw new Error("[list-slack-status-emoji] SLACK_EMOJI_MAP didn't parse to an object");
  }
  return new Set(Object.keys(map).map((k) => k.toLowerCase()));
}

/**
 * Lightweight fallback glyph lookup for the "missing — add these"
 * suggestions. We don't try to be exhaustive — just enough to give
 * the operator a plausible starting glyph when a brand-new shortcode
 * shows up. Anything not in here gets a "TODO glyph" placeholder.
 *
 * Source: hand-picked from the most-used Slack default emoji list,
 * kept short on purpose. If a workspace-custom emoji shows up here,
 * the right answer is "leave the fallback dot" — we can't render
 * Slack's custom PNG inline anyway.
 */
const FALLBACK_GLYPHS = {
  airplane_departure: "🛫", airplane_arriving: "🛬",
  beer: "🍺", beers: "🍻", wine_glass: "🍷",
  birthday: "🎂", baby_chick: "🐥", cake: "🎂",
  bulb: "💡", calendar_spiral: "🗓️",
  clipboard: "📋", chart_with_upwards_trend: "📈",
  construction_worker: "👷", crystal_ball: "🔮",
  dancer: "💃", dog: "🐶", cat: "🐱",
  exclamation: "❗", grey_exclamation: "❕",
  question: "❓", grey_question: "❔",
  family: "👪", flag: "🚩",
  flushed: "😳", gem: "💎", gift: "🎁",
  graduation_cap: "🎓", grin: "😀",
  hammer_and_wrench: "🛠️", handshake: "🤝",
  heavy_division_sign: "➗", heavy_minus_sign: "➖", heavy_plus_sign: "➕",
  hourglass: "⌛", hourglass_flowing_sand: "⏳",
  ice_cream: "🍨", icecream: "🍦",
  joystick: "🕹️", key: "🔑",
  ladybug: "🐞", lightning: "⚡", zap: "⚡",
  lipstick: "💄", lollipop: "🍭",
  microphone: "🎤", mic: "🎤",
  moneybag: "💰", money_with_wings: "💸",
  no_mouth: "😶", nut_and_bolt: "🔩",
  pencil: "✏️", pencil2: "✏️",
  popcorn: "🍿", pray: "🙏",
  raised_hand: "✋", relieved: "😌",
  ring: "💍", running: "🏃",
  saluting_face: "🫡", santa: "🎅",
  scream: "😱", shield: "🛡️",
  shrug: "🤷", silent: "🤫", shushing_face: "🤫",
  ski: "🎿", smile: "😄", smiley: "😃",
  smirk: "😏", snowflake: "❄️", soccer: "⚽",
  spaghetti: "🍝", sparkler: "🎇",
  star2: "🌟", stuck_out_tongue: "😛",
  sun_with_face: "🌞", sunny: "☀️",
  surfer: "🏄", swimmer: "🏊",
  thumbsup_all: "👍", tools: "🛠️",
  triangular_flag_on_post: "🚩", trophy: "🏆",
  umbrella: "☂️", umbrella_with_rain_drops: "☔",
  v: "✌️", weight_lifter: "🏋️",
  yum: "😋", zombie: "🧟",
};

function suggestGlyph(shortcode) {
  return FALLBACK_GLYPHS[shortcode.toLowerCase()] ?? null;
}

async function main() {
  loadEnv();

  const token = (process.env.SLACK_BOT_TOKEN ?? "").trim();
  if (!token) {
    console.error(
      `${COLOR.red}[list-slack-status-emoji] SLACK_BOT_TOKEN missing in .env — nothing to probe.${COLOR.reset}`
    );
    process.exit(1);
  }

  // Resolve every roster entry's Slack id(s). Hard-coded slackIds in
  // src/team.js take precedence; we layer data/slack-overrides.json on
  // top of them just like src/team.js does at runtime.
  const overrides = (() => {
    try {
      const raw = readFileSync(OVERRIDES_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  })();

  const userIdToMember = new Map();
  for (const m of TEAM) {
    const ids = Array.from(
      new Set([...(m.slackIds ?? []), ...(overrides[m.slug] ?? [])])
    ).filter((s) => typeof s === "string" && s.trim());
    for (const id of ids) userIdToMember.set(id, m);
  }

  if (userIdToMember.size === 0) {
    console.error(
      `${COLOR.yellow}[list-slack-status-emoji] no Slack ids in roster + overrides — nothing to fetch.${COLOR.reset}`
    );
    process.exit(0);
  }

  console.log(
    `${COLOR.bold}Probing Slack for ${userIdToMember.size} roster member(s)…${COLOR.reset}`
  );

  const slack = new WebClient(token);
  const results = await Promise.allSettled(
    Array.from(userIdToMember.keys()).map(async (uid) => {
      const r = await slack.users.profile.get({ user: uid });
      return { uid, profile: r?.profile ?? {} };
    })
  );

  /** @type {Map<string, { setBy: string[], text: string|null }>} */
  const codeToInfo = new Map();
  let failures = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") {
      failures += 1;
      continue;
    }
    const { uid, profile } = r.value;
    const member = userIdToMember.get(uid);
    const rawEmoji = String(profile.status_emoji ?? "").trim();
    if (!rawEmoji) continue;
    const code = rawEmoji.replace(/^:|:$/g, "").toLowerCase();
    if (!code) continue;
    const text = String(profile.status_text ?? "").trim() || null;
    if (!codeToInfo.has(code)) {
      codeToInfo.set(code, { setBy: [], text });
    }
    codeToInfo.get(code).setBy.push(member?.fullName ?? uid);
  }

  if (failures > 0) {
    console.warn(
      `${COLOR.yellow}  (${failures} profile fetch(es) failed — likely a missing scope. ` +
        `If unexpected, run scripts/verify-slack.sh.)${COLOR.reset}`
    );
  }

  const mapped = readMappedShortcodes();

  const inUse = Array.from(codeToInfo.entries())
    .map(([code, info]) => ({ code, ...info, mapped: mapped.has(code) }))
    .sort((a, b) => a.code.localeCompare(b.code));

  console.log("");
  console.log(`${COLOR.bold}Currently in use (${inUse.length} unique shortcode(s)):${COLOR.reset}`);
  if (inUse.length === 0) {
    console.log(`  ${COLOR.dim}(no member has a status emoji set)${COLOR.reset}`);
  }
  for (const { code, setBy, text, mapped: isMapped } of inUse) {
    const tag = isMapped
      ? `${COLOR.green}✓ mapped${COLOR.reset}`
      : `${COLOR.red}✗ MISSING${COLOR.reset}`;
    const who = setBy.length === 1 ? setBy[0] : `${setBy.length} members`;
    console.log(`  :${code}:  ${tag}  ${COLOR.dim}— ${who}${text ? ` · "${text}"` : ""}${COLOR.reset}`);
  }

  const missing = inUse.filter((x) => !x.mapped);
  console.log("");
  if (missing.length === 0) {
    console.log(
      `${COLOR.green}${COLOR.bold}All in-use shortcodes are mapped — no action needed.${COLOR.reset}`
    );
    return;
  }

  console.log(
    `${COLOR.yellow}${COLOR.bold}MISSING — add ${missing.length} entr${
      missing.length === 1 ? "y" : "ies"
    } to SLACK_EMOJI_MAP in public/index.html:${COLOR.reset}`
  );
  console.log(`${COLOR.dim}  // Auto-suggested by scripts/list-slack-status-emoji.mjs${COLOR.reset}`);
  for (const { code } of missing) {
    const guess = suggestGlyph(code);
    if (guess) {
      console.log(`  "${code}": "${guess}",`);
    } else {
      console.log(
        `  "${code}": "TODO_GLYPH", ${COLOR.dim}// custom workspace emoji? leave to fall back to •${COLOR.reset}`
      );
    }
  }
}

main().catch((err) => {
  console.error(
    `${COLOR.red}[list-slack-status-emoji] failed:${COLOR.reset}`,
    err?.message ?? err
  );
  process.exit(1);
});
