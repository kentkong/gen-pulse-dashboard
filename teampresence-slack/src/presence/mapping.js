/**
 * Slack status → presence bucket mapping.
 *
 * Pure functions; no IO, no Slack client, no network. This module is
 * the "brain" that turns a Slack profile blob (emoji + text +
 * auto-presence) into one of six unified presence buckets the UI
 * understands. It is pure so it can be unit-tested cheaply and
 * shared between the real Slack provider and the preview server.
 *
 * The heuristic is intentionally rule-based (not ML) so CSM teams
 * can eyeball a member's status and know exactly which bucket it
 * will land in — "accuracy is the most important thing".
 *
 * Buckets:
 *   available   — at desk, responsive
 *   wfh         — working remote (home, travel, focus elsewhere)
 *   meeting     — in a call / head-down, don't disturb
 *   away        — short-term OOO (lunch, coffee, brb, late)
 *   vacation    — full-day OOO (PTO, holiday, sick leave)
 *                 Overridden by Workday when the Workday provider is
 *                 enabled and returns a vacation record for today.
 *   unknown     — no signal at all (no status, auto-presence missing)
 *
 * Why not use the /teampresence bot commands' finer-grained labels
 * (in/wfh/late/out/off)? CSM feedback was "just use Slack status —
 * it must be accurate". This module collapses the buckets to exactly
 * what a CSM team needs to know at-a-glance.
 */

export const BUCKETS = Object.freeze({
  AVAILABLE: "available",
  WFH: "wfh",
  MEETING: "meeting",
  AWAY: "away",
  VACATION: "vacation",
  UNKNOWN: "unknown",
});

/* ------------------------------------------------------------------ *
 * Emoji lookups.
 *
 * Slack status emojis are case-sensitive strings like ":palm_tree:".
 * We group them into semantic buckets. Add here when the team's
 * actual usage surfaces new emojis we should recognise.
 * ------------------------------------------------------------------ */

const EMOJI_VACATION = new Set([
  ":palm_tree:",
  ":beach_with_umbrella:",
  ":desert_island:",
  ":airplane:",
  ":airplane_departure:",
  ":airplane_arriving:",
  ":sunny:",
  ":sun_with_face:",
  ":tent:",
  ":mountain:",
  ":mountain_snow:",
  ":christmas_tree:",
]);

const EMOJI_SICK_OR_FAMILY = new Set([
  ":face_with_thermometer:",
  ":hospital:",
  ":mask:",
  ":sneezing_face:",
  ":nauseated_face:",
  ":baby:",
  ":family:",
]);

const EMOJI_WFH = new Set([
  ":house:",
  ":house_with_garden:",
  ":home:",
  ":baguette_bread:",
  ":laptop:",
  ":computer:",
]);

const EMOJI_MEETING = new Set([
  ":spiral_calendar_pad:",
  ":date:",
  ":calendar:",
  ":headphones:",
  ":headphone:",
  ":phone:",
  ":telephone_receiver:",
  ":red_circle:",
  ":no_entry:",
  ":no_entry_sign:",
  ":eyes:",
  ":brain:",
  ":dart:",
  ":zipper_mouth_face:",
]);

const EMOJI_AWAY = new Set([
  ":coffee:",
  ":fork_and_knife:",
  ":knife_fork_plate:",
  ":sandwich:",
  ":hamburger:",
  ":pizza:",
  ":running:",
  ":walking:",
  ":oncoming_automobile:",
  ":car:",
  ":train:",
  ":bus:",
  ":station:",
  ":tram:",
]);

/* ------------------------------------------------------------------ *
 * Text lookups. Case-insensitive substring matches.
 * Ordered from most specific (vacation > sick > away > wfh).
 * ------------------------------------------------------------------ */

const TEXT_VACATION = [
  "vacation",
  "holiday",
  "pto",
  "ooo",
  "oof",
  "out of office",
  "annual leave",
  "on leave",
  "leave until",
];
const TEXT_SICK = ["sick", "unwell", "doctor", "medical", "appointment"];
const TEXT_AWAY = [
  "lunch",
  "brb",
  "afk",
  "coffee",
  "break",
  "running late",
  "train delay",
  "commute",
  "on my way",
];
const TEXT_WFH = ["wfh", "working from home", "remote", "home office", "focus"];
const TEXT_MEETING = [
  "in a meeting",
  "in a call",
  "on a call",
  "do not disturb",
  "dnd",
  "deep work",
  "head down",
  "heads down",
];

/**
 * Classify a Slack profile into a bucket.
 *
 * @param {object} profile
 * @param {string} [profile.status_emoji]     e.g. ":palm_tree:"
 * @param {string} [profile.status_text]      free-form user text
 * @param {number} [profile.status_expiration]UNIX seconds (0 = no expiry)
 * @param {"active"|"away"|null} [profile.presence]  Slack auto-presence
 * @returns {{bucket: string, reason: string}}
 */
export function classifySlackStatus(profile = {}) {
  const emoji = String(profile.status_emoji ?? "").trim();
  const text = String(profile.status_text ?? "").trim();
  const textLc = text.toLowerCase();
  const presence = profile.presence;

  // Highest priority: Slack auto-presence = away + empty status text.
  // This reliably means "Slack client is inactive"; treat as AWAY unless
  // other signals (below) clearly indicate something more specific.

  // 1. Emoji-based matches (most specific).
  if (emoji) {
    if (EMOJI_VACATION.has(emoji)) {
      return { bucket: BUCKETS.VACATION, reason: `emoji ${emoji}` };
    }
    if (EMOJI_SICK_OR_FAMILY.has(emoji)) {
      return { bucket: BUCKETS.VACATION, reason: `emoji ${emoji} (sick/family)` };
    }
    if (EMOJI_MEETING.has(emoji)) {
      return { bucket: BUCKETS.MEETING, reason: `emoji ${emoji}` };
    }
    if (EMOJI_AWAY.has(emoji)) {
      return { bucket: BUCKETS.AWAY, reason: `emoji ${emoji}` };
    }
    if (EMOJI_WFH.has(emoji)) {
      return { bucket: BUCKETS.WFH, reason: `emoji ${emoji}` };
    }
  }

  // 2. Text-based matches (ordered from specific to general).
  if (anyMatch(textLc, TEXT_VACATION)) {
    return { bucket: BUCKETS.VACATION, reason: `text match "${firstMatch(textLc, TEXT_VACATION)}"` };
  }
  if (anyMatch(textLc, TEXT_SICK)) {
    return { bucket: BUCKETS.VACATION, reason: `text match "${firstMatch(textLc, TEXT_SICK)}" (sick)` };
  }
  if (anyMatch(textLc, TEXT_MEETING)) {
    return { bucket: BUCKETS.MEETING, reason: `text match "${firstMatch(textLc, TEXT_MEETING)}"` };
  }
  if (anyMatch(textLc, TEXT_AWAY)) {
    return { bucket: BUCKETS.AWAY, reason: `text match "${firstMatch(textLc, TEXT_AWAY)}"` };
  }
  if (anyMatch(textLc, TEXT_WFH)) {
    return { bucket: BUCKETS.WFH, reason: `text match "${firstMatch(textLc, TEXT_WFH)}"` };
  }

  // 3. Auto-presence fallbacks.
  if (presence === "away") {
    return { bucket: BUCKETS.AWAY, reason: "Slack auto-presence = away" };
  }
  if (presence === "active") {
    return { bucket: BUCKETS.AVAILABLE, reason: "Slack auto-presence = active" };
  }

  // 4. No signal at all.
  return { bucket: BUCKETS.UNKNOWN, reason: "no status or presence" };
}

function anyMatch(hay, needles) {
  return needles.some((n) => hay.includes(n));
}
function firstMatch(hay, needles) {
  return needles.find((n) => hay.includes(n)) ?? "";
}

/**
 * Format a Slack status for display. Returns null when there's
 * nothing useful to show. Emoji is passed through unchanged (the UI
 * decides whether to render it or swap to an image via Slack's
 * custom-emoji URL).
 */
export function formatSlackStatusLine(profile = {}) {
  const emoji = String(profile.status_emoji ?? "").trim();
  const text = String(profile.status_text ?? "").trim();
  if (!emoji && !text) return null;
  if (!emoji) return text;
  if (!text) return emoji;
  return `${emoji} ${text}`;
}
