/**
 * Presence aggregator.
 *
 * Given a list of Slack user IDs + (optional) Workday provider,
 * returns a unified presence object per user. Workday always wins
 * over Slack when both report something — i.e. if Workday says you're
 * on PTO today, the card shows Vacation even if you forgot to update
 * your Slack status.
 *
 * This module is the ONLY place where provider outputs are combined.
 * Keeping the merge logic here (instead of sprinkled through web.js)
 * means we can unit-test "what bucket do I land in?" without spinning
 * up an HTTP server or mocking Bolt.
 */

import { BUCKETS } from "./mapping.js";

export { BUCKETS } from "./mapping.js";
export { createSlackStatusProvider } from "./slack-status.js";
export {
  createNoopWorkdayProvider,
  createCsvWorkdayProvider,
  createIcalWorkdayProvider,
  createRestWorkdayProvider,
  workdayProviderFromEnv,
} from "./workday.js";

/**
 * @typedef {Object} UnifiedPresence
 * @property {string} bucket         BUCKETS.*
 * @property {string} reason         Human-readable "why" (shown in the drawer)
 * @property {"slack"|"workday"|"none"} source   Which provider wins
 * @property {string|null} statusLine   Slack status text (displayed on the card)
 * @property {string} statusEmoji
 * @property {string} statusText
 * @property {number} statusExpiration  UNIX seconds (0 = no expiry)
 * @property {"active"|"away"|null} autoPresence
 * @property {string|null} vacationType PTO|Sick|Holiday|... when source=workday
 * @property {string|null} through      ISO date, end of vacation (inclusive)
 * @property {number} updatedAt         ms
 */

/**
 * @param {object} opts
 * @param {string[]} opts.userIds
 * @param {{fetchPresenceForUsers: Function}} opts.slackProvider
 * @param {{fetchPresenceForUsers: Function, kind: string}} [opts.workdayProvider]
 * @param {Map<string, string>} [opts.emailByUserId]  for CSV Workday matching
 * @returns {Promise<Map<string, UnifiedPresence>>}
 */
export async function resolvePresence({
  userIds,
  slackProvider,
  workdayProvider,
  emailByUserId,
  slugByUserId,
}) {
  if (!Array.isArray(userIds)) {
    throw new Error("resolvePresence: userIds must be an array");
  }
  if (!slackProvider?.fetchPresenceForUsers) {
    throw new Error("resolvePresence: slackProvider required");
  }

  const slackByUser = await slackProvider.fetchPresenceForUsers(userIds);

  let workdayByUser = new Map();
  if (workdayProvider?.fetchPresenceForUsers) {
    try {
      workdayByUser = await workdayProvider.fetchPresenceForUsers(userIds, {
        emailByUserId: emailByUserId ?? new Map(),
        slugByUserId: slugByUserId ?? new Map(),
      });
    } catch (err) {
      // Don't let Workday failures break the whole widget.
      console.warn("[presence] Workday provider failed:", err?.message);
      workdayByUser = new Map();
    }
  }

  const out = new Map();
  for (const uid of userIds) {
    const slack = slackByUser.get(uid) ?? null;
    const workday = workdayByUser.get(uid) ?? null;

    // Workday VACATION always wins — it's the authoritative source
    // for whole-day OOO. Keep the Slack status_text/emoji around so
    // the UI can still show "🏖️ Ibiza through Fri" as a helpful
    // secondary line.
    if (workday && workday.bucket === BUCKETS.VACATION) {
      out.set(uid, {
        bucket: workday.bucket,
        reason: workday.reason,
        source: "workday",
        statusLine: slack?.statusLine ?? null,
        statusEmoji: slack?.statusEmoji ?? "",
        statusText: slack?.statusText ?? "",
        statusExpiration: slack?.statusExpiration ?? 0,
        autoPresence: slack?.autoPresence ?? null,
        vacationType: workday.vacationType,
        through: workday.through,
        updatedAt: Math.max(workday.updatedAt, slack?.updatedAt ?? 0),
      });
      continue;
    }

    // Otherwise the Slack provider is the source of truth. No slack
    // data? bucket → UNKNOWN.
    if (slack) {
      out.set(uid, {
        bucket: slack.bucket,
        reason: slack.reason,
        source: "slack",
        statusLine: slack.statusLine,
        statusEmoji: slack.statusEmoji,
        statusText: slack.statusText,
        statusExpiration: slack.statusExpiration,
        autoPresence: slack.autoPresence,
        vacationType: null,
        through: null,
        updatedAt: slack.updatedAt,
      });
    } else {
      out.set(uid, {
        bucket: BUCKETS.UNKNOWN,
        reason: "no presence data",
        source: "none",
        statusLine: null,
        statusEmoji: "",
        statusText: "",
        statusExpiration: 0,
        autoPresence: null,
        vacationType: null,
        through: null,
        updatedAt: Date.now(),
      });
    }
  }
  return out;
}

/**
 * Fetch upcoming absences from the Workday provider and decorate each
 * with the matched roster member (name, avatar, role). Anything that
 * can't be matched to the roster is dropped — we don't want to show
 * absences for people the team doesn't recognise.
 *
 * Shape of each returned row:
 *   {
 *     slackId, email, slug, startDate, endDate, type, note,
 *     member: { name, fullName, avatarUrl, role, team, slug } | null
 *   }
 *
 * `type` is the raw Workday type (PTO/Sick/...) — the UI layer is
 * responsible for privacy-masking this to "Vacation" in public views.
 */
export async function listUpcomingAbsences({
  workdayProvider,
  days = 7,
  roster = [],
  identitiesBySlackId = new Map(),
}) {
  if (!workdayProvider?.listUpcomingAbsences) return [];

  const byEmail = new Map();
  const bySlug = new Map();
  const bySlackId = new Map();
  for (const m of roster) {
    if (m.email) byEmail.set(String(m.email).toLowerCase(), m);
    if (m.slug) bySlug.set(m.slug, m);
    for (const sid of m.slackIds ?? []) bySlackId.set(sid, m);
  }
  // Also index identities learned at runtime (Slack users.info emails).
  for (const [sid, ident] of identitiesBySlackId) {
    if (ident?.email) byEmail.set(String(ident.email).toLowerCase(), ident);
    bySlackId.set(sid, ident);
  }

  // Build slug → live Slack identity so we can prefer the Slack-CDN
  // avatar (public, cacheable) over the static roster PNG. The roster
  // avatars live behind the dashboard key, so when the absence widget
  // renders `<img src="/team/<slug>.png">` unauthenticated it 401s and
  // shows a broken icon — exactly what the Workday widget screenshot
  // surfaced. Using the same CDN URL the roster grid already uses keeps
  // the two surfaces visually consistent.
  const identityBySlug = new Map();
  for (const m of roster) {
    if (!m.slug) continue;
    for (const sid of m.slackIds ?? []) {
      const ident = identitiesBySlackId.get(sid);
      if (ident?.avatarUrl) {
        identityBySlug.set(m.slug, ident);
        break;
      }
    }
  }

  const rows = await workdayProvider.listUpcomingAbsences(days);
  const out = [];
  for (const row of rows) {
    const member =
      (row.slackId && bySlackId.get(row.slackId)) ||
      (row.email && byEmail.get(String(row.email).toLowerCase())) ||
      (row.slug && bySlug.get(row.slug)) ||
      null;
    if (!member) continue;
    const liveIdent =
      (row.slackId && identitiesBySlackId.get(row.slackId)) ||
      (member.slug && identityBySlug.get(member.slug)) ||
      null;
    out.push({
      slackId: row.slackId,
      email: row.email,
      slug: row.slug || member.slug || null,
      startDate: row.startDate,
      endDate: row.endDate,
      type: row.type,
      note: row.note,
      member: {
        // Keep the roster's short-form name (e.g. "Jan B.") — it's the
        // deliberate display style for the widget. We only borrow the
        // live Slack avatar, not the display name.
        name: member.displayName || member.name || member.fullName,
        fullName: member.fullName || member.name,
        avatarUrl: liveIdent?.avatarUrl ?? member.avatarUrl ?? null,
        role: member.role ?? null,
        team: member.team ?? null,
        slug: member.slug ?? null,
      },
    });
  }
  return out;
}
