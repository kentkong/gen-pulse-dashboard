/**
 * Slack status presence provider.
 *
 * Reads each roster member's Slack profile (users.profile.get) and
 * current presence (users.getPresence), then maps that to a bucket
 * using the pure helpers in mapping.js. Results are cached per user
 * for a short TTL to keep the dashboard well under Slack's per-workspace
 * rate limits — the widget refreshes every 30s but we only hit Slack
 * at most once every SLACK_STATUS_TTL_MS per user.
 *
 * Provider contract (shared by all presence providers):
 *
 *   async fetchPresenceForUsers(userIds) → Map<userId, {
 *     bucket,            // one of BUCKETS
 *     reason,            // human-readable "why this bucket"
 *     statusText,        // Slack's raw status_text (may be empty)
 *     statusEmoji,       // Slack's raw status_emoji (may be empty)
 *     statusLine,        // pre-formatted "emoji + text" or null
 *     statusExpiration,  // UNIX seconds, 0 = no expiry
 *     autoPresence,      // "active" | "away" | null
 *     updatedAt,         // ms when we fetched the data
 *     source,            // "slack" (for the UI's source chip)
 *   }>
 */

import {
  classifySlackStatus,
  formatSlackStatusLine,
  BUCKETS,
} from "./mapping.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 min — balances freshness vs rate limits

export function createSlackStatusProvider({
  app,
  ttlMs = DEFAULT_TTL_MS,
  logger = console,
} = {}) {
  if (!app?.client) {
    throw new Error("createSlackStatusProvider: app.client required");
  }
  const cache = new Map(); // userId -> { payload, fetchedAt }

  async function fetchOne(userId) {
    const cached = cache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.payload;
    }
    // Two parallel calls per user:
    //  - users.profile.get → status_text / status_emoji / status_expiration
    //  - users.getPresence → auto-presence (active/away based on Slack UI)
    // If either fails (e.g. scope missing), we degrade gracefully to UNKNOWN
    // rather than throwing — one broken user shouldn't break the widget.
    const [profileRes, presenceRes] = await Promise.allSettled([
      app.client.users.profile.get({ user: userId }),
      app.client.users.getPresence({ user: userId }),
    ]);
    const profile =
      profileRes.status === "fulfilled" ? profileRes.value?.profile ?? {} : {};
    const autoPresence =
      presenceRes.status === "fulfilled"
        ? presenceRes.value?.presence ?? null
        : null;

    if (profileRes.status === "rejected") {
      logger.warn?.(
        `[presence:slack] users.profile.get failed for ${userId}:`,
        profileRes.reason?.data?.error ?? profileRes.reason?.message
      );
    }
    if (presenceRes.status === "rejected") {
      logger.warn?.(
        `[presence:slack] users.getPresence failed for ${userId}:`,
        presenceRes.reason?.data?.error ?? presenceRes.reason?.message
      );
    }

    const classification = classifySlackStatus({
      status_emoji: profile.status_emoji,
      status_text: profile.status_text,
      status_expiration: profile.status_expiration,
      presence: autoPresence,
    });

    const payload = {
      bucket: classification.bucket,
      reason: classification.reason,
      statusText: String(profile.status_text ?? ""),
      statusEmoji: String(profile.status_emoji ?? ""),
      statusLine: formatSlackStatusLine({
        status_emoji: profile.status_emoji,
        status_text: profile.status_text,
      }),
      statusExpiration: Number(profile.status_expiration ?? 0),
      autoPresence,
      updatedAt: Date.now(),
      source: "slack",
    };
    cache.set(userId, { payload, fetchedAt: Date.now() });
    return payload;
  }

  async function fetchPresenceForUsers(userIds) {
    const out = new Map();
    // Slack's rate limits are generous for these two endpoints (tier 3 /
    // tier 4). Fetch in parallel; if the workspace is very large we can
    // add a concurrency cap later, but for ~10–50 CSM members this is
    // fine.
    const results = await Promise.allSettled(
      userIds.map((u) => fetchOne(u).then((p) => [u, p]))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        out.set(r.value[0], r.value[1]);
      } else {
        logger.warn?.("[presence:slack] fetchOne unexpectedly threw:", r.reason);
      }
    }
    // Any user we couldn't fetch at all → surface UNKNOWN so the row
    // still shows up in the UI with a clear reason.
    for (const uid of userIds) {
      if (!out.has(uid)) {
        out.set(uid, {
          bucket: BUCKETS.UNKNOWN,
          reason: "Slack API call failed",
          statusText: "",
          statusEmoji: "",
          statusLine: null,
          statusExpiration: 0,
          autoPresence: null,
          updatedAt: Date.now(),
          source: "slack",
        });
      }
    }
    return out;
  }

  return { fetchPresenceForUsers };
}
