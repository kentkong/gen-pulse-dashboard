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
