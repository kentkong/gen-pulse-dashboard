import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPresence,
  listCheckinsForDate,
  listRecentRollcalls,
  listRollcallResponses,
  listAllKnownUserIds,
} from "./db.js";
import { WIDGETS, widgetById } from "./widgets.js";
import { loadRolesFromEnv, rolesForUser, widgetVisibleTo } from "./roles.js";
import {
  buildWeeklyThroughput,
  buildBacklogOverview,
  buildTicketLifecycle,
  buildKanbanBoard,
  buildInflowVsResolved,
  buildSlaAgingRisk,
  parseSlaThresholds,
  buildTopPriorityTickets,
  buildSprintBacklog,
  buildReopenRate,
  buildThroughputLeaderboard,
} from "./reports.js";
import { jiraFromEnv } from "./jira.js";
import { TEAM, findBySlackId, initialsFor } from "./team.js";
import {
  filterForWeeklyThroughput,
  filterForBacklogOverview,
  filterForTicketLifecycle,
  filterForInflowVsResolved,
  filterForSlaAgingRisk,
  filterForKanban,
  filterForTopPriority,
  filterForSprintBacklog,
  filterForReopenRate,
  filterForThroughputLeaderboard,
} from "./filters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, "index.html");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseCsv(envValue) {
  return (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function authorized(req, key) {
  if (!key) return true;
  const provided =
    req.query?.key ??
    (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return provided === key;
}

export function registerWebRoutes({
  app,
  db,
  displayName,
  brandName,
  timezone,
  todayInTz,
}) {
  const router = app?.receiver?.router;
  if (!router) {
    console.log("[web] receiver has no router (likely socket mode) — dashboard disabled");
    return;
  }

  const dashboardKey = (process.env.DASHBOARD_KEY ?? "").trim();
  const seedMemberIds = parseCsv(process.env.TEAM_MEMBER_IDS);
  const rolesByTeam = loadRolesFromEnv();
  const throughputJql = (process.env.JIRA_THROUGHPUT_JQL ?? "").trim();
  const backlogJql = (process.env.JIRA_BACKLOG_JQL ?? "").trim();
  const lifecycleJql = (process.env.JIRA_LIFECYCLE_JQL ?? "").trim();
  const lifecyclePrevJql = (process.env.JIRA_LIFECYCLE_PREV_JQL ?? "").trim();
  const lifecycleLookbackDays =
    Number(process.env.JIRA_LIFECYCLE_LOOKBACK_DAYS ?? 30) || 30;
  const kanbanJql = (process.env.JIRA_KANBAN_JQL ?? "").trim();
  const kanbanColumns = parseCsv(process.env.JIRA_KANBAN_COLUMNS);
  const kanbanBoardUrl = (process.env.JIRA_KANBAN_URL ?? "").trim() || null;
  // Inflow vs Resolved: defaults to the throughput JQL's "base" (without
  // the date filters). Fallback to the throughput JQL itself — the
  // builder wraps with created/resolved range filters so either works.
  const inflowJql =
    (process.env.JIRA_INFLOW_JQL ?? "").trim() || throughputJql;
  // SLA / aging risk: defaults to the backlog JQL (all open tickets).
  const slaJql = (process.env.JIRA_SLA_JQL ?? "").trim() || backlogJql;
  const slaThresholds = parseSlaThresholds(process.env.JIRA_SLA_THRESHOLDS);
  // Top priority tickets: scope to the single "To Do" column of the
  // team's RapidBoard by default (minimal Jira load). Falls back to
  // the backlog JQL if the Kanban JQL isn't set.
  const topPriorityJql =
    (process.env.JIRA_TOP_PRIORITY_JQL ?? "").trim() ||
    kanbanJql ||
    backlogJql;
  const topPriorityPriorities =
    parseCsv(process.env.JIRA_TOP_PRIORITIES).length > 0
      ? parseCsv(process.env.JIRA_TOP_PRIORITIES)
      : ["Highest", "Critical", "High"];
  const topPriorityStatus = (
    process.env.JIRA_TOP_PRIORITY_STATUS ?? "To Do"
  ).trim();
  const topPriorityLimit =
    Number(process.env.JIRA_TOP_PRIORITY_LIMIT ?? 6) || 6;

  // Sprint backlog: defaults to the Kanban JQL's To Do column.
  const sprintBacklogJql =
    (process.env.JIRA_SPRINT_BACKLOG_JQL ?? "").trim() ||
    kanbanJql ||
    backlogJql;
  const sprintBacklogStatus = (
    process.env.JIRA_SPRINT_BACKLOG_STATUS ?? "To Do"
  ).trim();

  // Reopen / escalation rate: scope is the whole project (uses
  // throughput JQL by default, falls back to backlog). Done statuses
  // list matters for status-change queries.
  const reopenJql =
    (process.env.JIRA_REOPEN_JQL ?? "").trim() || throughputJql || backlogJql;
  const reopenDoneStatuses =
    parseCsv(process.env.JIRA_DONE_STATUSES).length > 0
      ? parseCsv(process.env.JIRA_DONE_STATUSES)
      : ["Done", "Closed", "Resolved"];
  const reopenWindowDays =
    Number(process.env.JIRA_REOPEN_WINDOW_DAYS ?? 30) || 30;

  // Team throughput leaderboard: shares the throughput JQL so the
  // "last week total" on the leaderboard agrees with the big
  // throughput KPI above it. Limit is tunable for teams with more
  // than ~6 resolvers per week.
  const leaderboardJql =
    (process.env.JIRA_LEADERBOARD_JQL ?? "").trim() ||
    throughputJql ||
    backlogJql;
  const leaderboardLimit =
    Number(process.env.JIRA_LEADERBOARD_LIMIT ?? 6) || 6;

  const VERY_SHORT_TTL_MS = 90 * 1000;
  const SHORT_TTL_MS = 5 * 60 * 1000;
  const MEDIUM_TTL_MS = 15 * 60 * 1000;

  function makeCachedBuilder({ ttlMs, buildFn, reasonNoJql, getJql }) {
    const cache = { payload: null, fetchedAt: 0 };
    const getter = async function ({ force = false } = {}) {
      if (!force && cache.payload && Date.now() - cache.fetchedAt < ttlMs) {
        return cache.payload;
      }
      const jira = jiraFromEnv();
      const jql = getJql();
      if (!jira || !jql) {
        return {
          unavailable: true,
          reason: !jira ? "JIRA_BASE_URL / JIRA_TOKEN not set" : reasonNoJql,
          generatedAt: Date.now(),
        };
      }
      const payload = await buildFn({ jira, jql });
      cache.payload = payload;
      cache.fetchedAt = Date.now();
      return payload;
    };
    // Expose TTL so the filter drawer can say "refreshes every N".
    getter.ttlMs = ttlMs;
    return getter;
  }

  /**
   * Pick which env var (of a list of candidates) actually supplied the
   * JQL. Returns `{ source, fallbackFrom }` where `source` is the first
   * candidate that is non-empty, and `fallbackFrom` is the *intended*
   * first candidate when a later one had to be used.
   */
  function resolveSource(candidates) {
    const nonEmpty = candidates.find(([, v]) => (v ?? "").trim().length > 0);
    const [primary] = candidates;
    if (!nonEmpty) {
      return { source: primary?.[0] ?? null, fallbackFrom: null };
    }
    const [sourceName] = nonEmpty;
    const fallbackFrom =
      sourceName !== primary[0] ? primary[0] : null;
    return { source: sourceName, fallbackFrom };
  }

  const getThroughput = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    reasonNoJql: "JIRA_THROUGHPUT_JQL not set",
    getJql: () => throughputJql,
    buildFn: ({ jira, jql }) => buildWeeklyThroughput({ jira, jql, timezone }),
  });

  const getBacklog = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    reasonNoJql: "JIRA_BACKLOG_JQL not set",
    getJql: () => backlogJql,
    buildFn: ({ jira, jql }) => buildBacklogOverview({ jira, jql, timezone }),
  });

  const getLifecycle = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    reasonNoJql: "JIRA_LIFECYCLE_JQL not set",
    getJql: () => lifecycleJql,
    buildFn: ({ jira, jql }) =>
      buildTicketLifecycle({
        jira,
        jql,
        jqlPrevious: lifecyclePrevJql || undefined,
        lookbackDays: lifecycleLookbackDays,
        timezone,
      }),
  });

  const getKanban = makeCachedBuilder({
    ttlMs: VERY_SHORT_TTL_MS,
    reasonNoJql: "JIRA_KANBAN_JQL not set",
    getJql: () => kanbanJql,
    buildFn: ({ jira, jql }) =>
      buildKanbanBoard({
        jira,
        jql,
        columns: kanbanColumns.length > 0 ? kanbanColumns : null,
        timezone,
        boardUrl: kanbanBoardUrl,
      }),
  });

  const getInflow = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    reasonNoJql: "JIRA_INFLOW_JQL / JIRA_THROUGHPUT_JQL not set",
    getJql: () => inflowJql,
    buildFn: ({ jira, jql }) => buildInflowVsResolved({ jira, jql, timezone }),
  });

  const getSlaRisk = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    reasonNoJql: "JIRA_SLA_JQL / JIRA_BACKLOG_JQL not set",
    getJql: () => slaJql,
    buildFn: ({ jira, jql }) =>
      buildSlaAgingRisk({ jira, jql, thresholds: slaThresholds, timezone }),
  });

  const getTopPriority = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    reasonNoJql: "JIRA_TOP_PRIORITY_JQL / JIRA_KANBAN_JQL not set",
    getJql: () => topPriorityJql,
    buildFn: ({ jira, jql }) =>
      buildTopPriorityTickets({
        jira,
        jql,
        priorities: topPriorityPriorities,
        status: topPriorityStatus,
        topN: topPriorityLimit,
        timezone,
      }),
  });

  const getSprintBacklog = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    reasonNoJql: "JIRA_SPRINT_BACKLOG_JQL / JIRA_KANBAN_JQL not set",
    getJql: () => sprintBacklogJql,
    buildFn: ({ jira, jql }) =>
      buildSprintBacklog({
        jira,
        jql,
        status: sprintBacklogStatus,
        boardUrl: kanbanBoardUrl,
        timezone,
      }),
  });

  const getReopenRate = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    reasonNoJql: "JIRA_REOPEN_JQL / JIRA_THROUGHPUT_JQL not set",
    getJql: () => reopenJql,
    buildFn: ({ jira, jql }) =>
      buildReopenRate({
        jira,
        jql,
        doneStatuses: reopenDoneStatuses,
        windowDays: reopenWindowDays,
        timezone,
      }),
  });

  const getThroughputLeaderboard = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    reasonNoJql: "JIRA_LEADERBOARD_JQL / JIRA_THROUGHPUT_JQL not set",
    getJql: () => leaderboardJql,
    buildFn: ({ jira, jql }) =>
      buildThroughputLeaderboard({
        jira,
        jql,
        topN: leaderboardLimit,
        timezone,
      }),
  });

  function callerUserId(req) {
    const q = req.query?.user;
    if (q && typeof q === "string") return q;
    const h = req.headers?.["x-slack-user-id"];
    if (h && typeof h === "string") return h;
    return null;
  }

  function callerRoles(req) {
    const uid = callerUserId(req);
    return uid ? rolesForUser(uid, rolesByTeam) : new Set(["any"]);
  }

  router.get("/", (req, res, next) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).type("text/plain").send("Unauthorized — append ?key=…");
      return;
    }
    fs.readFile(INDEX_HTML_PATH, "utf8", (err, html) => {
      if (err) {
        next(err);
        return;
      }
      const rendered = html.replaceAll("{{BRAND_NAME}}", brandName);
      res.type("text/html").send(rendered);
    });
  });

  router.get("/healthz", (req, res) => {
    res.type("text/plain").send("ok");
  });

  router.get("/team/:file", (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    const file = req.params.file;
    if (!/^[\w.\-]+\.(png|jpg|jpeg|webp)$/i.test(file)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const abs = path.resolve(PUBLIC_DIR, "team", file);
    if (!abs.startsWith(path.join(PUBLIC_DIR, "team") + path.sep)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    fs.readFile(abs, (err, buf) => {
      if (err) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".png" ? "image/png"
        : ext === ".webp" ? "image/webp"
        : "image/jpeg";
      res.setHeader("cache-control", "public, max-age=3600");
      res.type(mime).send(buf);
    });
  });

  router.get("/api/team", async (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const date = todayInTz();
      const checkins = listCheckinsForDate(db, date);
      const checkinByUser = new Map(checkins.map((c) => [c.userId, c]));

      const thirtyDaysAgo = Date.now() - 30 * MS_PER_DAY;
      const knownIds = listAllKnownUserIds(db, thirtyDaysAgo);
      const memberIds = Array.from(new Set([...seedMemberIds, ...knownIds]));

      const members = await Promise.all(
        memberIds.map(async (userId) => {
          const presence = getPresence(db, userId);
          const checkin = checkinByUser.get(userId) ?? null;
          const identity = await loadIdentity(userId);
          const rosterEntry = findBySlackId(userId);
          const name = identity?.displayName || userId;
          return {
            id: userId,
            name,
            avatarUrl: identity?.avatarUrl ?? null,
            initials: identity?.initials ?? null,
            title: identity?.title ?? null,
            role: rosterEntry?.role ?? null,
            team: rosterEntry?.team ?? null,
            tags: rosterEntry?.tags ?? [],
            checkin: checkin
              ? {
                  state: checkin.state,
                  note: checkin.note,
                  updatedAt: checkin.updatedAt,
                }
              : null,
            presence: presence
              ? {
                  state: presence.state,
                  note: presence.note,
                  untilTs: presence.until_ts,
                  updatedAt: presence.updated_at,
                }
              : null,
          };
        })
      );

      const seenNames = new Set(members.map((m) => m.name.toLowerCase()));
      for (const fallback of rosterFallbackMembers()) {
        if (!seenNames.has(fallback.name.toLowerCase())) {
          members.push(fallback);
        }
      }

      members.sort((a, b) => a.name.localeCompare(b.name));

      const rollcalls = listRecentRollcalls(db, 5).map((rc) => {
        const responses = listRollcallResponses(db, rc.id);
        const counts = { attending: 0, late: 0, absent: 0 };
        for (const r of responses) {
          if (counts[r.status] !== undefined) counts[r.status] += 1;
        }
        return {
          id: rc.id,
          title: rc.title,
          createdAt: rc.createdAt,
          channelId: rc.channelId,
          counts,
          totalResponses: responses.length,
        };
      });

      res.json({
        brandName,
        date,
        timezone,
        generatedAt: Date.now(),
        members,
        rollcalls,
      });
    } catch (err) {
      console.error("[web] /api/team failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  const identityCache = new Map();
  const IDENTITY_TTL_MS = 10 * 60 * 1000;

  function initialsFrom(name) {
    if (!name) return "?";
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0][0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
  }

  async function loadIdentity(userId) {
    if (!userId) return null;
    const cached = identityCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < IDENTITY_TTL_MS) {
      return cached.payload;
    }
    const rosterEntry = findBySlackId(userId);
    let payload = { userId };
    try {
      const info = await app.client.users.info({ user: userId });
      const p = info?.user?.profile ?? {};
      const slackDisplay =
        p.display_name_normalized ||
        p.real_name_normalized ||
        info?.user?.real_name ||
        info?.user?.name ||
        null;
      const displayName =
        slackDisplay || rosterEntry?.displayName || rosterEntry?.fullName || userId;
      payload = {
        userId,
        displayName,
        firstName: p.first_name ?? displayName.split(" ")[0] ?? "",
        title: p.title || rosterEntry?.title || "",
        email: p.email ?? "",
        avatarUrl:
          p.image_72 ?? p.image_48 ?? p.image_32 ?? rosterEntry?.avatarUrl ?? null,
        initials: initialsFrom(displayName),
      };
    } catch (err) {
      console.warn("[web] users.info failed for", userId, err?.data?.error ?? err?.message);
      const displayName =
        rosterEntry?.displayName || rosterEntry?.fullName || userId;
      payload = {
        userId,
        displayName,
        firstName: rosterEntry?.fullName?.split(" ")[0] ?? "",
        title: rosterEntry?.title ?? "",
        email: "",
        avatarUrl: rosterEntry?.avatarUrl ?? null,
        initials: initialsFor(rosterEntry?.fullName ?? userId),
      };
    }
    identityCache.set(userId, { payload, fetchedAt: Date.now() });
    return payload;
  }

  function rosterFallbackMembers() {
    // Seed /api/team with every roster entry that isn't yet mapped to a
    // live Slack id — so the UI shows the real team even before people
    // start interacting with the bot.
    return TEAM
      .filter((m) => m.slackIds.length === 0)
      .map((m) => ({
        id: `roster:${m.slug}`,
        name: m.displayName || m.fullName,
        avatarUrl: m.avatarUrl,
        initials: initialsFor(m.fullName),
        title: m.title,
        role: m.role ?? null,
        team: m.team ?? null,
        tags: m.tags ?? [],
        checkin: null,
        presence: null,
      }));
  }

  router.get("/api/me", async (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const userId = callerUserId(req);
    const roles = Array.from(callerRoles(req));
    const identity = await loadIdentity(userId);
    res.json({
      userId,
      roles,
      displayName: identity?.displayName ?? null,
      firstName: identity?.firstName ?? null,
      title: identity?.title ?? null,
      email: identity?.email ?? null,
      avatarUrl: identity?.avatarUrl ?? null,
      initials: identity?.initials ?? null,
      profileUrl: userId
        ? `slack://user?team=&id=${encodeURIComponent(userId)}`
        : null,
      canCustomize: roles.includes("manager") || roles.includes("any"),
    });
  });

  router.get("/api/widgets", (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const roles = callerRoles(req);
    res.json({
      widgets: WIDGETS.filter((w) => widgetVisibleTo(w, roles)),
    });
  });

  /**
   * Attach structured filter metadata to every Jira widget response so
   * the dashboard's filter drawer can show CSM teams exactly what is
   * being queried (source env var, fallback chain, parameters, raw JQL,
   * refresh cadence). Filter meta is computed at response time so it
   * reflects any fallback that actually fired.
   */
  function registerWidgetRoute(id, getter, buildFilterMeta) {
    router.get(`/api/widgets/${id}`, async (req, res) => {
      if (!authorized(req, dashboardKey)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const widget = widgetById(id);
      if (!widgetVisibleTo(widget, callerRoles(req))) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      try {
        const payload = await getter({ force: req.query?.force === "1" });
        let filter = null;
        if (buildFilterMeta && !payload?.unavailable) {
          try {
            filter = buildFilterMeta(payload);
          } catch (err) {
            console.warn(`[web] filter meta failed for ${id}:`, err?.message);
          }
        }
        res.json(filter ? { ...payload, filter } : payload);
      } catch (err) {
        console.error(`[web] ${id} failed:`, err);
        res.status(500).json({
          error: "internal",
          message: String(err?.message ?? err),
        });
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Filter-meta builders per widget. Each captures the env-var source
   * chain at route-registration time, then (when a response lands)
   * reads the executed JQL + generatedAt from the payload so the UI
   * sees exactly what was run — not what *would* have been run.
   * ------------------------------------------------------------------ */

  const throughputSrc = resolveSource([
    ["JIRA_THROUGHPUT_JQL", process.env.JIRA_THROUGHPUT_JQL],
  ]);
  const backlogSrc = resolveSource([
    ["JIRA_BACKLOG_JQL", process.env.JIRA_BACKLOG_JQL],
  ]);
  const lifecycleSrc = resolveSource([
    ["JIRA_LIFECYCLE_JQL", process.env.JIRA_LIFECYCLE_JQL],
  ]);
  const kanbanSrc = resolveSource([
    ["JIRA_KANBAN_JQL", process.env.JIRA_KANBAN_JQL],
  ]);
  const inflowSrc = resolveSource([
    ["JIRA_INFLOW_JQL", process.env.JIRA_INFLOW_JQL],
    ["JIRA_THROUGHPUT_JQL", process.env.JIRA_THROUGHPUT_JQL],
  ]);
  const slaSrc = resolveSource([
    ["JIRA_SLA_JQL", process.env.JIRA_SLA_JQL],
    ["JIRA_BACKLOG_JQL", process.env.JIRA_BACKLOG_JQL],
  ]);
  const topPrioritySrc = resolveSource([
    ["JIRA_TOP_PRIORITY_JQL", process.env.JIRA_TOP_PRIORITY_JQL],
    ["JIRA_KANBAN_JQL", process.env.JIRA_KANBAN_JQL],
    ["JIRA_BACKLOG_JQL", process.env.JIRA_BACKLOG_JQL],
  ]);
  const sprintBacklogSrc = resolveSource([
    ["JIRA_SPRINT_BACKLOG_JQL", process.env.JIRA_SPRINT_BACKLOG_JQL],
    ["JIRA_KANBAN_JQL", process.env.JIRA_KANBAN_JQL],
    ["JIRA_BACKLOG_JQL", process.env.JIRA_BACKLOG_JQL],
  ]);
  const reopenSrc = resolveSource([
    ["JIRA_REOPEN_JQL", process.env.JIRA_REOPEN_JQL],
    ["JIRA_THROUGHPUT_JQL", process.env.JIRA_THROUGHPUT_JQL],
    ["JIRA_BACKLOG_JQL", process.env.JIRA_BACKLOG_JQL],
  ]);
  const leaderboardSrc = resolveSource([
    ["JIRA_LEADERBOARD_JQL", process.env.JIRA_LEADERBOARD_JQL],
    ["JIRA_THROUGHPUT_JQL", process.env.JIRA_THROUGHPUT_JQL],
    ["JIRA_BACKLOG_JQL", process.env.JIRA_BACKLOG_JQL],
  ]);

  registerWidgetRoute("weekly-throughput", getThroughput, (p) =>
    filterForWeeklyThroughput({
      jql: p?.jql ?? throughputJql,
      source: throughputSrc.source,
      fallbackFrom: throughputSrc.fallbackFrom,
      refreshSeconds: Math.round(getThroughput.ttlMs / 1000),
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("backlog-overview", getBacklog, (p) =>
    filterForBacklogOverview({
      jql: p?.jql ?? backlogJql,
      source: backlogSrc.source,
      fallbackFrom: backlogSrc.fallbackFrom,
      refreshSeconds: Math.round(getBacklog.ttlMs / 1000),
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("ticket-lifecycle", getLifecycle, (p) =>
    filterForTicketLifecycle({
      jql: p?.jql ?? lifecycleJql,
      source: lifecycleSrc.source,
      fallbackFrom: lifecycleSrc.fallbackFrom,
      refreshSeconds: Math.round(getLifecycle.ttlMs / 1000),
      lookbackDays: lifecycleLookbackDays,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("inflow-vs-resolved", getInflow, (p) =>
    filterForInflowVsResolved({
      jql: p?.jql ?? inflowJql,
      source: inflowSrc.source,
      fallbackFrom: inflowSrc.fallbackFrom,
      refreshSeconds: Math.round(getInflow.ttlMs / 1000),
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("sla-aging-risk", getSlaRisk, (p) =>
    filterForSlaAgingRisk({
      jql: p?.jql ?? slaJql,
      source: slaSrc.source,
      fallbackFrom: slaSrc.fallbackFrom,
      refreshSeconds: Math.round(getSlaRisk.ttlMs / 1000),
      thresholds: slaThresholds,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("sprint-backlog", getSprintBacklog, (p) =>
    filterForSprintBacklog({
      jql: p?.jql ?? sprintBacklogJql,
      source: sprintBacklogSrc.source,
      fallbackFrom: sprintBacklogSrc.fallbackFrom,
      refreshSeconds: Math.round(getSprintBacklog.ttlMs / 1000),
      status: sprintBacklogStatus,
      boardUrl: kanbanBoardUrl,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("reopen-rate", getReopenRate, (p) =>
    filterForReopenRate({
      jql: p?.jql ?? reopenJql,
      source: reopenSrc.source,
      fallbackFrom: reopenSrc.fallbackFrom,
      refreshSeconds: Math.round(getReopenRate.ttlMs / 1000),
      doneStatuses: reopenDoneStatuses,
      windowDays: reopenWindowDays,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("top-priority-tickets", getTopPriority, (p) =>
    filterForTopPriority({
      jql: p?.jql ?? topPriorityJql,
      source: topPrioritySrc.source,
      fallbackFrom: topPrioritySrc.fallbackFrom,
      refreshSeconds: Math.round(getTopPriority.ttlMs / 1000),
      priorities: topPriorityPriorities,
      status: topPriorityStatus,
      limit: topPriorityLimit,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("throughput-leaderboard", getThroughputLeaderboard, (p) =>
    filterForThroughputLeaderboard({
      jql: p?.jql ?? leaderboardJql,
      source: leaderboardSrc.source,
      fallbackFrom: leaderboardSrc.fallbackFrom,
      refreshSeconds: Math.round(getThroughputLeaderboard.ttlMs / 1000),
      limit: leaderboardLimit,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );
  registerWidgetRoute("kanban-board", getKanban, (p) =>
    filterForKanban({
      jql: p?.jql ?? kanbanJql,
      source: kanbanSrc.source,
      fallbackFrom: kanbanSrc.fallbackFrom,
      refreshSeconds: Math.round(getKanban.ttlMs / 1000),
      columns: kanbanColumns,
      boardUrl: kanbanBoardUrl,
      timezone,
      generatedAt: p?.generatedAt,
    })
  );

  console.log(
    `[web] dashboard enabled at / — ${dashboardKey ? "key required" : "no key (dev only)"}`
  );
}
