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
} from "./reports.js";
import { jiraFromEnv } from "./jira.js";

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

  const VERY_SHORT_TTL_MS = 90 * 1000;
  const SHORT_TTL_MS = 5 * 60 * 1000;
  const MEDIUM_TTL_MS = 15 * 60 * 1000;

  function makeCachedBuilder({ ttlMs, buildFn, reasonNoJql, getJql }) {
    const cache = { payload: null, fetchedAt: 0 };
    return async function ({ force = false } = {}) {
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
          const name = identity?.displayName || userId;
          return {
            id: userId,
            name,
            avatarUrl: identity?.avatarUrl ?? null,
            initials: identity?.initials ?? null,
            title: identity?.title ?? null,
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
    let payload = { userId };
    try {
      const info = await app.client.users.info({ user: userId });
      const p = info?.user?.profile ?? {};
      const displayName =
        p.display_name_normalized ||
        p.real_name_normalized ||
        info?.user?.real_name ||
        info?.user?.name ||
        userId;
      payload = {
        userId,
        displayName,
        firstName: p.first_name ?? displayName.split(" ")[0] ?? "",
        title: p.title ?? "",
        email: p.email ?? "",
        avatarUrl: p.image_72 ?? p.image_48 ?? p.image_32 ?? null,
        initials: initialsFrom(displayName),
      };
    } catch (err) {
      console.warn("[web] users.info failed for", userId, err?.data?.error ?? err?.message);
      payload = {
        userId,
        displayName: userId,
        firstName: "",
        title: "",
        email: "",
        avatarUrl: null,
        initials: initialsFrom(userId),
      };
    }
    identityCache.set(userId, { payload, fetchedAt: Date.now() });
    return payload;
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

  function registerWidgetRoute(id, getter) {
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
        res.json(payload);
      } catch (err) {
        console.error(`[web] ${id} failed:`, err);
        res.status(500).json({
          error: "internal",
          message: String(err?.message ?? err),
        });
      }
    });
  }

  registerWidgetRoute("weekly-throughput", getThroughput);
  registerWidgetRoute("backlog-overview", getBacklog);
  registerWidgetRoute("ticket-lifecycle", getLifecycle);
  registerWidgetRoute("kanban-board", getKanban);

  console.log(
    `[web] dashboard enabled at / — ${dashboardKey ? "key required" : "no key (dev only)"}`
  );
}
