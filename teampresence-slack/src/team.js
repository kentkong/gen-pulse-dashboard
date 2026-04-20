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
 */

const AVATAR_BASE = "/team";

export const TEAM = [
  {
    slug: "daniel-zabensky",
    fullName: "Daniel Žabenský",
    displayName: "Daniel Ž.",
    title: "Customer Success — EMAIL Norton",
    tags: ["CS"],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/daniel-zabensky.png`,
  },
  {
    slug: "iryna-botulinska",
    fullName: "Iryna Botulinska",
    displayName: "Iryna B.",
    title: "Email Marketing — EMAIL Norton",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/iryna-botulinska.png`,
  },
  {
    slug: "victor-shapochkin",
    fullName: "Victor Shapochkin",
    displayName: "Victor S.",
    title: "Email Marketing — EMAIL Norton",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/victor-shapochkin.png`,
  },
  {
    slug: "petr-studeny",
    fullName: "Petr Studený",
    displayName: "Petr S.",
    title: "Email Marketing — EMAIL Norton",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/petr-studeny.png`,
  },
  {
    slug: "yanina-scholz",
    fullName: "Yanina Scholz",
    displayName: "Yanina S.",
    title: "Email Marketing — EMAIL Norton",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/yanina-scholz.png`,
  },
  {
    slug: "volodymyr-yatsenko",
    fullName: "Volodymyr Yatsenko",
    displayName: "Volodymyr Y.",
    title: "Customer Success — EMAIL Norton",
    tags: ["CS"],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/volodymyr-yatsenko.png`,
  },
  {
    slug: "kristyna-simkova",
    fullName: "Kristýna Šimková",
    displayName: "Kristýna Š.",
    title: "Email Marketing — EMAIL Norton",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/kristyna-simkova.png`,
  },
  {
    slug: "jan-bartoncik",
    fullName: "Jan Bartončík",
    displayName: "Jan B.",
    title: "Email Marketing — EMAIL Norton",
    tags: [],
    slackIds: [],
    avatarUrl: `${AVATAR_BASE}/jan-bartoncik.png`,
  },
];

export function initialsFor(fullName) {
  if (!fullName) return "?";
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}

function bySlug() {
  const map = new Map();
  for (const m of TEAM) map.set(m.slug, m);
  return map;
}

function bySlackId() {
  const map = new Map();
  for (const m of TEAM) for (const id of m.slackIds) map.set(id, m);
  return map;
}

const SLUG_INDEX = bySlug();
const SLACK_INDEX = bySlackId();

export function findBySlug(slug) {
  return SLUG_INDEX.get(slug) ?? null;
}

export function findBySlackId(userId) {
  return SLACK_INDEX.get(userId) ?? null;
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
  } = {}
) {
  const entry = findBySlug(slug);
  if (!entry) return null;
  return {
    id: id ?? entry.slug,
    name: entry.displayName || entry.fullName,
    fullName: entry.fullName,
    avatarUrl: entry.avatarUrl,
    initials: initialsFor(entry.fullName),
    title: entry.title,
    tags: entry.tags,
    checkin,
    presence,
  };
}
