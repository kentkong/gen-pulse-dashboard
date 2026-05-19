/**
 * EMAIL NORTON team roster — single source of truth for
 * display names, titles and local avatar paths.
 *
 * Used by:
 *   - src/preview.js         (mock /api/team when Slack is not wired up)
 *   - src/web.js             (identity fallback if Slack users.info is
 *                             missing a photo, title or both)
 *
 * To link a roster entry to a real Slack user, add their Slack user
 * id to the `slackIds` array. Multiple ids are accepted (e.g. workspace
 * moves, bot-impersonation, shared profiles).
 *
 * Photos live under /public/team/<slug>.png and are served by the web
 * layer. When switched to prod Slack, real Slack profile photos take
 * precedence — the local avatar is only used as a fallback.
 *
 * ---------------- Slack-id override layer ----------------
 * Real Slack IDs are NOT checked into this file. They live in
 *   data/slack-overrides.json           (gitignored)
 * with shape
 *   { "slug": ["U0123ABCD", ...], ... }
 * and are merged into the roster at module load. This keeps PII
 * (Slack workspace identifiers) out of the repo and lets the
 * `scripts/activate-slack.sh` one-shot activator regenerate the
 * mapping without touching source code. Missing file = silent
 * no-op; malformed JSON logs a warning and falls through.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLACK_OVERRIDES_PATH = path.join(
  __dirname,
  "..",
  "data",
  "slack-overrides.json"
);

const AVATAR_BASE = "/team";

// Roster order is the display order everywhere — Team Presence rows,
// preview seeds, leaderboards. Clustered by function so the eye reads
// them as groups rather than a random list:
//
//   1. Customer Success      — Daniel, Volodymyr
//   2. Developers / engineers — Iryna, Victor
//   3. Marketing / targeting  — Yanina, Petr, Kristýna, Jan
export const TEAM = [
  // --- Customer Success -------------------------------------------------
  {
    slug: "daniel-zabensky",
    fullName: "Daniel Žabenský",
    displayName: "Daniel Ž.",
    role: "Customer Success Specialist",
    team: "Customer Success",
    title: "Customer Success Specialist · Customer Success",
    tags: ["CS"],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/daniel-zabensky.png`,
  },
  {
    slug: "volodymyr-yatsenko",
    fullName: "Volodymyr Yatsenko",
    displayName: "Volodymyr Y.",
    role: "Front-End Developer",
    team: "Customer Success",
    title: "Front-End Developer · Customer Success",
    tags: ["CS"],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/volodymyr-yatsenko.png`,
  },

  // --- Developers / engineers ------------------------------------------
  {
    slug: "iryna-botulinska",
    fullName: "Iryna Botulinska",
    displayName: "Iryna B.",
    role: "Principal Front-End Developer",
    team: "Email Marketing",
    title: "Principal Front-End Developer · Email Marketing",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/iryna-botulinska.png`,
  },
  {
    slug: "victor-shapochkin",
    fullName: "Victor Shapochkin",
    displayName: "Victor S.",
    role: "Sr. Principal Software Engineer",
    team: "Email Marketing",
    title: "Sr. Principal Software Engineer · Email Marketing",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/victor-shapochkin.png`,
  },

  // --- Marketing / targeting specialists -------------------------------
  {
    slug: "yanina-scholz",
    fullName: "Yanina Scholz",
    displayName: "Yanina S.",
    role: "Targeting Specialist",
    team: "Email Marketing",
    title: "Targeting Specialist · Email Marketing",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/yanina-scholz.png`,
  },
  {
    slug: "petr-studeny",
    fullName: "Petr Studený",
    displayName: "Petr S.",
    role: "Sr. Online Marketing Specialist",
    team: "Email Marketing",
    title: "Sr. Online Marketing Specialist · Email Marketing",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/petr-studeny.png`,
  },
  {
    slug: "kristyna-simkova",
    fullName: "Kristýna Šimková",
    displayName: "Kristýna Š.",
    role: "Sr. Online Marketing Specialist",
    team: "Email Marketing",
    title: "Sr. Online Marketing Specialist · Email Marketing",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/kristyna-simkova.png`,
  },
  {
    slug: "jan-bartoncik",
    fullName: "Jan Bartončík",
    displayName: "Jan B.",
    role: "Sr. Online Marketing Specialist",
    team: "Email Marketing",
    title: "Sr. Online Marketing Specialist · Email Marketing",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/jan-bartoncik.png`,
  },
];

/**
 * Merge slackIds from data/slack-overrides.json into the TEAM
 * array in-place, before any of the index maps are built. Silent
 * on missing file (pre-Slack state); warns on malformed JSON so a
 * typo in the overrides file doesn't brick the roster.
 */
function applySlackIdOverrides() {
  let raw;
  try {
    raw = fs.readFileSync(SLACK_OVERRIDES_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return; // no overrides yet — expected pre-Slack
    console.warn(
      `[team] slack overrides: unreadable at ${SLACK_OVERRIDES_PATH}:`,
      err.message
    );
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[team] slack overrides: malformed JSON — ignoring`, err.message);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const bySlugLocal = new Map(TEAM.map((m) => [m.slug, m]));
  let applied = 0;
  for (const [slug, ids] of Object.entries(parsed)) {
    // Accept JSON "comment" keys (`//`, `//generated`, etc.) — the
    // activator writes a small preamble we shouldn't warn about.
    if (slug.startsWith("/")) continue;
    // Namespaced keys (e.g. `avast:ivo-zedek`) belong to a different
    // roster's override layer; skip them silently here so the Norton
    // loader doesn't log "unknown slug" for every AVAST entry.
    // applyAvastSlackOverrides() picks them up by its own namespace
    // filter below.
    if (slug.includes(":")) continue;
    const entry = bySlugLocal.get(slug);
    if (!entry) {
      console.warn(`[team] slack overrides: unknown slug "${slug}" — skipped`);
      continue;
    }
    if (!Array.isArray(ids)) continue;
    const clean = ids
      .map((x) => String(x ?? "").trim())
      .filter((x) => /^[UW][A-Z0-9]{7,}$/.test(x));
    if (clean.length === 0) continue;
    // Replace, not append — activator is the source of truth.
    entry.slackIds = clean;
    applied += 1;
  }
  if (applied > 0) {
    console.log(`[team] slack overrides: applied to ${applied} roster entries`);
  }
}
applySlackIdOverrides();

/* ================================================================ *
 * AVAST Freemium team roster — hardcoded canonical list, mirroring
 * the shape of TEAM (Norton). Members were confirmed by Kevin Mold
 * on 2026-04-28. JIRA_AVAST_INCLUDE_ASSIGNEES in .env must stay in
 * lockstep: it filters Jira ticket queries by assignee, while this
 * array drives Team Presence and the /api/team payload.
 *
 * Display rules:
 *   - Diacritic-accurate fullName preserved as given by the user
 *   - Customer Success members are tagged ["CS"] and grouped under
 *     team "Customer Success" (matches Norton convention)
 *   - Display order is CS first, then engineering, then marketing/
 *     targeting, then platform / business analyst — same pattern as
 *     the Norton roster so rows read as functional groups
 *
 * Slack IDs and avatars: unknown at present. Entries start empty
 * and can be enriched via data/slack-overrides.json (same mechanism
 * as Norton — keys prefixed with "avast:" to avoid slug collisions).
 * ================================================================ */

export const TEAM_AVAST = [
  // --- Customer Success -------------------------------------------------
  {
    slug: "vit-radosta",
    fullName: "Vít Radosta",
    displayName: "Vít R.",
    role: "Front-End Developer",
    team: "Customer Success",
    title: "Front-End Developer · Customer Success",
    tags: ["CS"],
    slackIds: [],
    avatarUrl: null,
  },

  // --- Engineering ------------------------------------------------------
  {
    slug: "marian-dragomir",
    fullName: "Marian Dragomir",
    displayName: "Marian D.",
    role: "Principal Software Engineer",
    team: "AVAST Freemium",
    title: "Principal Software Engineer · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },
  {
    slug: "mihai-cristian-fugaciu",
    fullName: "Mihai Cristian Fugaciu",
    displayName: "Mihai F.",
    role: "Principal Front-End Developer",
    team: "AVAST Freemium",
    title: "Principal Front-End Developer · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },
  {
    slug: "denisa-kocvarova",
    fullName: "Denisa Kocvárová",
    displayName: "Denisa K.",
    role: "Sr. Software Engineer",
    team: "AVAST Freemium",
    title: "Sr. Software Engineer · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },

  // --- Marketing / targeting -------------------------------------------
  {
    slug: "denisa-pavlikova",
    fullName: "Denisa Pavlíková",
    displayName: "Denisa P.",
    role: "Sr. Online Marketing Specialist",
    team: "AVAST Freemium",
    title: "Sr. Online Marketing Specialist · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },
  {
    slug: "uliana-kolomiiets",
    fullName: "Uliana Kolomiiets",
    displayName: "Uliana K.",
    role: "Targeting Specialist",
    team: "AVAST Freemium",
    title: "Targeting Specialist · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },

  // --- Platform / business analysis ------------------------------------
  {
    slug: "anna-alduz",
    fullName: "Anna Aldüz",
    displayName: "Anna A.",
    role: "Email Platform Specialist",
    team: "AVAST Freemium",
    title: "Email Platform Specialist · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },
  {
    slug: "ivo-zedek",
    fullName: "Ivo Zedek",
    displayName: "Ivo Z.",
    role: "Sr. IT Business Analyst",
    team: "AVAST Freemium",
    title: "Sr. IT Business Analyst · AVAST Freemium",
    tags: [],
    slackIds: [],
    avatarUrl: null,
  },
];

// Apply Slack-ID overrides to AVAST (same mechanism as Norton —
// keys prefixed with "avast:" in data/slack-overrides.json to avoid
// slug collisions across rosters).
function applyAvastSlackOverrides() {
  let raw;
  try {
    raw = fs.readFileSync(SLACK_OVERRIDES_PATH, "utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const bySlugAvast = new Map(TEAM_AVAST.map((m) => [m.slug, m]));
  let applied = 0;
  for (const [key, ids] of Object.entries(parsed)) {
    if (!key.startsWith("avast:")) continue;
    const slug = key.slice("avast:".length);
    const entry = bySlugAvast.get(slug);
    if (!entry || !Array.isArray(ids)) continue;
    const clean = ids
      .map((x) => String(x ?? "").trim())
      .filter((x) => /^[UW][A-Z0-9]{7,}$/.test(x));
    if (clean.length > 0) {
      entry.slackIds = clean;
      applied += 1;
    }
  }
  if (applied > 0) {
    console.log(`[team] slack overrides (avast): applied to ${applied} entries`);
  }
}
applyAvastSlackOverrides();

// Team registry. Keyed by the same strings exposed as TEAM_KEYS in
// jira-projects.js. Callers that want a specific roster should use
// `getRoster(teamKey)` rather than reaching into this object
// directly so future team additions don't require editing every
// call site.
export const TEAMS = Object.freeze({
  norton: TEAM,
  avast: TEAM_AVAST,
});

export function getRoster(teamKey) {
  const k = String(teamKey ?? "norton").toLowerCase();
  return TEAMS[k] ?? TEAM;
}

export function initialsFor(fullName) {
  if (!fullName) return "?";
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}

function bySlug(roster = TEAM) {
  const map = new Map();
  for (const m of roster) map.set(m.slug, m);
  return map;
}

function bySlackId(roster = TEAM) {
  const map = new Map();
  for (const m of roster) for (const id of m.slackIds) map.set(id, m);
  return map;
}

/**
 * Normalise a person's name for fuzzy lookup against the roster.
 * Strips diacritics, punctuation and whitespace, lower-cases.
 *
 *   "Kristýna Šimková"   → "kristynasimkova"
 *   "Simkova, Kristyna"  → "simkovakristyna"
 *   "Kristyna Simkova "  → "kristynasimkova"
 *
 * Workday / Excel exports are notoriously inconsistent about
 * diacritics and "Last, First" vs "First Last" — this is a
 * single normalisation funnel so the CSV and iCal loaders can
 * match them the same way.
 */
export function normaliseName(name) {
  if (!name) return "";
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function byName(roster = TEAM) {
  const map = new Map();
  for (const m of roster) {
    const full = normaliseName(m.fullName);
    const disp = normaliseName(m.displayName);
    if (full) map.set(full, m);
    if (disp) map.set(disp, m);
    // Also accept "Last First" (Workday's common format)
    const parts = String(m.fullName).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const reversed = normaliseName([parts[parts.length - 1], parts[0]].join(" "));
      if (reversed) map.set(reversed, m);
    }
  }
  return map;
}

const SLUG_INDEX = bySlug(TEAM);
const SLACK_INDEX = bySlackId(TEAM);
const NAME_INDEX = byName(TEAM);

const SLUG_INDEX_AVAST = bySlug(TEAM_AVAST);
const SLACK_INDEX_AVAST = bySlackId(TEAM_AVAST);
const NAME_INDEX_AVAST = byName(TEAM_AVAST);

function pickIndex(teamKey, norton, avast) {
  return String(teamKey ?? "norton").toLowerCase() === "avast" ? avast : norton;
}

export function findBySlug(slug, teamKey = "norton") {
  return pickIndex(teamKey, SLUG_INDEX, SLUG_INDEX_AVAST).get(slug) ?? null;
}

export function findBySlackId(userId, teamKey = "norton") {
  return pickIndex(teamKey, SLACK_INDEX, SLACK_INDEX_AVAST).get(userId) ?? null;
}

/**
 * Best-effort match of a free-form person name (as emitted by
 * Workday / HR reports) against the roster. Returns the TEAM entry
 * or null. See `normaliseName` for the matching rules.
 */
export function findByName(name, teamKey = "norton") {
  const key = normaliseName(name);
  if (!key) return null;
  return pickIndex(teamKey, NAME_INDEX, NAME_INDEX_AVAST).get(key) ?? null;
}

/**
 * Build a `/api/team`-shaped member object from a roster entry.
 * `presenceState` / `checkinState` are optional and used by the preview
 * server to seed a visually interesting mock board.
 */
export function rosterMember(
  slug,
  {
    id = null,
    presence = null,
    checkin = null,
    slackStatus = null,
    workday = null,
    teamKey = "norton",
  } = {}
) {
  const entry = findBySlug(slug, teamKey);
  if (!entry) return null;
  return {
    id: id ?? entry.slug,
    name: entry.displayName || entry.fullName,
    fullName: entry.fullName,
    avatarUrl: entry.avatarUrl,
    initials: initialsFor(entry.fullName),
    title: entry.title,
    role: entry.role ?? null,
    team: entry.team ?? null,
    tags: entry.tags,
    checkin,
    presence,
    slackStatus,
    workday,
  };
}
