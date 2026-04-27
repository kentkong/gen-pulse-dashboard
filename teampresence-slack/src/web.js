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
import {
  listProjects,
  defaultProjectKey,
  resolveJql,
  resolveProjectScalar,
  applyTeamScope,
  isValidProjectKey,
  ALL_PROJECT_KEY,
} from "./jira-projects.js";
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
import {
  resolvePresence,
  createSlackStatusProvider,
  workdayProviderFromEnv,
  listUpcomingAbsences,
  BUCKETS,
} from "./presence/index.js";
import { createAuthenticator } from "./auth.js";
import {
  initOidcFromEnv,
  startLoginRedirect,
  finishLoginCallback,
  performLogout,
  completeMockLogin,
} from "./oidc.js";
import { readTunnelState, buildShareLinks } from "./demoShare.js";
import { weatherServiceFromEnv } from "./weather.js";

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

/**
 * Thin compat shim. Existing route handlers call
 * `authorized(req, dashboardKey)` and expect a boolean; the new
 * `auth` object is module-scoped and created inside
 * registerWebRoutes. We keep the two-arg signature for zero-diff
 * migration, but internally delegate to the authenticator when
 * available so the future OIDC path is a single-file swap.
 */
let currentAuthenticator = null;
function authorized(req, key) {
  if (currentAuthenticator) {
    const { ok } = currentAuthenticator.authenticate(req);
    return ok;
  }
  // Fallback for any path that runs before registerWebRoutes()
  // has wired the authenticator.
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
  /* ---------------------------------------------------------------- *
   * Central authenticator.
   *
   * We start as shared-key (the safe always-works default). If
   * AUTH_STRATEGY=oidc is set in the env, we kick off Azure AD
   * discovery in the background and hot-swap the authenticator the
   * moment discovery resolves (usually <1s). This means:
   *
   *   - boot never blocks on Azure being reachable
   *   - a typo in OIDC_TENANT_ID can't take the dashboard down —
   *     it logs loudly and stays on shared-key
   *   - the /auth/login route is always registered; if discovery
   *     hasn't finished (first ~1s of server life) it returns 503
   *     with a human-readable hint
   *
   * See USER-ACCOUNT-PLAN.md for the rollout design.
   * ---------------------------------------------------------------- */
  currentAuthenticator = createAuthenticator({
    strategy: "shared-key",
    sharedKey: dashboardKey,
  });

  // Populated when OIDC discovery resolves. Used by /auth/* routes
  // AND by /api/me to return real identity data.
  let oidcConfig = null;

  const authStrategyEnv = (process.env.AUTH_STRATEGY ?? "").trim().toLowerCase();
  if (authStrategyEnv === "oidc" || authStrategyEnv === "mock-oidc") {
    initOidcFromEnv(process.env)
      .then((oidc) => {
        if (!oidc.ready) {
          console.warn(`[auth] OIDC not activated: ${oidc.reason}`);
          console.warn(
            `[auth] continuing with shared-key auth (DASHBOARD_KEY ${dashboardKey ? "set" : "UNSET — open door"})`
          );
          return;
        }
        oidcConfig = oidc;
        currentAuthenticator = createAuthenticator({
          strategy: "oidc",
          sharedKey: dashboardKey,
          oidc,
          allowSharedKeyFallback: oidc.allowSharedKeyFallback,
        });
        const fallback = oidc.allowSharedKeyFallback
          ? "shared-key ALSO accepted (OIDC_ALLOW_SHARED_KEY_FALLBACK=true)"
          : "SSO only";
        const mode = oidc.mock ? "MOCK" : "OIDC";
        console.log(
          `[auth] ${mode} enabled — issuer=${oidc.issuerUrl} redirect=${oidc.redirectUri} fallback=${fallback}`
        );
      })
      .catch((err) => {
        console.warn(
          `[auth] initOidcFromEnv threw: ${err?.message ?? err}. Staying on shared-key.`
        );
      });
  } else if (authStrategyEnv && authStrategyEnv !== "shared-key") {
    console.warn(
      `[auth] unknown AUTH_STRATEGY=${authStrategyEnv}; valid values: shared-key, oidc, mock-oidc. Staying on shared-key.`
    );
  }
  const seedMemberIds = parseCsv(process.env.TEAM_MEMBER_IDS);
  const rolesByTeam = loadRolesFromEnv();

  /* ---------------------------------------------------------------- *
   * Presence model feature flag.
   *
   * PRESENCE_MODEL controls where the Team Presence widget gets its
   * data from. Valid values:
   *
   *   bot           — legacy: SQLite check-ins + rollcalls from the
   *                   /teampresence Slack bot. This is the default and
   *                   what the original demo shipped with. Backwards-
   *                   compatible; no other env vars needed.
   *
   *   slack         — new: pulls each roster member's status_text,
   *                   status_emoji, and auto-presence from Slack
   *                   (users.profile.get + users.getPresence) and maps
   *                   it to a bucket via src/presence/mapping.js.
   *                   "Accuracy comes from your Slack status."
   *
   *   slack+workday — slack mode + Workday vacation overlay. Workday
   *                   wins for full-day OOO; Slack wins for in-the-
   *                   moment whereabouts. Workday provider chosen via
   *                   WORKDAY_PROVIDER (defaults to noop until IT
   *                   confirms the endpoint shape).
   *
   * See docs in src/presence/*.js for the full contract.
   * ---------------------------------------------------------------- */
  const presenceModel = (process.env.PRESENCE_MODEL ?? "bot")
    .trim()
    .toLowerCase();
  // Use substring matching so each provider is enabled/disabled
  // independently. Supported values:
  //   "bot"            — legacy Slack-bot checkin commands (default)
  //   "slack"          — read presence from Slack status only
  //   "workday"        — read vacations from Workday only (no Slack)
  //   "slack+workday"  — both; Workday wins for whole-day OOO
  // This lets us turn on Workday BEFORE Slack is approved by the
  // workspace admin, without synthesising a fake Slack provider.
  const presenceUsesSlack = /\bslack\b/.test(presenceModel);
  const presenceUsesWorkday = /\bworkday\b/.test(presenceModel);

  let slackPresenceProvider = null;
  let workdayPresenceProvider = null;
  if (presenceUsesSlack) {
    try {
      slackPresenceProvider = createSlackStatusProvider({ app });
      console.log(`[presence] model="${presenceModel}" (Slack status enabled)`);
    } catch (err) {
      console.warn(
        `[presence] failed to init Slack status provider: ${err.message}`
      );
    }
  }
  if (presenceUsesWorkday) {
    workdayPresenceProvider = workdayProviderFromEnv(process.env);
    console.log(
      `[presence] Workday provider: ${workdayPresenceProvider.kind ?? "unknown"}`
    );
  }

  /* ---------------------------------------------------------------- *
   * Weather widget — small hero-chip provider.
   *
   * Optional. Opts in when WEATHER_LAT + WEATHER_LON are set in the
   * env. See src/weather.js for the cache / soft-fail behaviour.
   * ---------------------------------------------------------------- */
  const weatherService = weatherServiceFromEnv(process.env);
  if (weatherService) {
    console.log(
      `[weather] enabled for "${weatherService.location}" via ${weatherService.kind}`
    );
  }
  /* ---------------------------------------------------------------- *
   * Jira multi-project wiring.
   *
   * The dashboard supports two parallel projects (EMOPS current,
   * EMAILCO legacy) with completely independent JQL per widget. The
   * UI switcher sends `?project=EMOPS|EMAILCO|all` and every widget
   * endpoint routes through this layer to pick the right JQL.
   *
   * When JIRA_PROJECT_KEYS is unset the resolver still works — it
   * falls back to the original single-project env vars
   * (`JIRA_THROUGHPUT_JQL`, etc.), so existing deployments are
   * unaffected.
   *
   * Non-JQL scalars (kanban columns/URL, thresholds, priorities,
   * status names, limits, lookback windows) are also scoped per
   * project via `resolveProjectScalar`, so the same deployment
   * can e.g. have different "To Do" column names in the two
   * projects' workflows without conflict.
   * ---------------------------------------------------------------- */
  const configuredProjects = listProjects(process.env);
  const hasMultiProject = configuredProjects.length > 0;
  const fallbackProjectKey = defaultProjectKey(process.env) ?? null;
  console.log(
    hasMultiProject
      ? `[jira] multi-project: ${configuredProjects
          .map((p) => p.key)
          .join(", ")} (default=${fallbackProjectKey})`
      : "[jira] single-project mode (no JIRA_PROJECT_KEYS set)"
  );

  // Global, project-invariant options (rarely differ per project).
  const slaThresholds = parseSlaThresholds(process.env.JIRA_SLA_THRESHOLDS);

  // Per-project scalar resolvers. Each returns the resolved value
  // plus which env var it came from (for the filter drawer).
  //
  // Why we peek at process.env keys directly:
  //   resolveProjectScalar returns `value: ""` both when the env var
  //   is missing AND when it's explicitly set to "". For filters like
  //   TOP_PRIORITY_STATUS we need those two cases to differ — an
  //   explicit empty should mean "no filter" rather than falling
  //   back to the hardcoded default ("To Do"). We therefore check
  //   for key presence and only apply `fallback` when the key isn't
  //   defined at any level.
  function perProjectScalar(projectKey, suffix, fallback) {
    const r = resolveProjectScalar(process.env, projectKey, suffix);
    const proj = String(projectKey || "").toUpperCase();
    const candidateKeys = [
      proj && proj !== "ALL" ? `JIRA_${proj}_${suffix}` : null,
      proj === "ALL" ? `JIRA_ALL_${suffix}` : null,
      `JIRA_${suffix}`,
    ].filter(Boolean);
    const keySetExplicitly = candidateKeys.some((k) =>
      Object.prototype.hasOwnProperty.call(process.env, k)
    );
    const value = keySetExplicitly ? r.value : fallback;
    return { value, source: r.source };
  }
  function perProjectList(projectKey, suffix, fallback) {
    const r = resolveProjectScalar(process.env, projectKey, suffix);
    const list = parseCsv(r.value);
    return { value: list.length > 0 ? list : fallback, source: r.source };
  }
  function perProjectNumber(projectKey, suffix, fallback) {
    const r = resolveProjectScalar(process.env, projectKey, suffix);
    const n = Number(r.value);
    return {
      value: Number.isFinite(n) && n > 0 ? n : fallback,
      source: r.source,
    };
  }

  const VERY_SHORT_TTL_MS = 90 * 1000;
  const SHORT_TTL_MS = 5 * 60 * 1000;
  const MEDIUM_TTL_MS = 15 * 60 * 1000;

  /**
   * Normalise the caller-supplied ?project= query param.
   * - Empty / missing  → the server-side default project (or null in
   *   single-project mode)
   * - Unknown key      → error (400 handled by the route)
   * - "ALL" / "all"    → the reserved ALL_PROJECT_KEY
   */
  function normaliseProject(req) {
    if (!hasMultiProject) return { key: null };
    const raw = (req.query?.project ?? "").toString().trim();
    if (!raw) return { key: fallbackProjectKey };
    const upper = raw.toLowerCase() === ALL_PROJECT_KEY
      ? ALL_PROJECT_KEY
      : raw.toUpperCase();
    if (!isValidProjectKey(process.env, upper)) {
      return { key: null, error: `unknown project "${raw}"` };
    }
    return { key: upper };
  }

  /**
   * Project-aware cached builder.
   *
   * Each widget getter now maintains a Map<projectKey,
   * {payload,fetchedAt}> so switching projects in the UI is
   * snappy — EMOPS data doesn't evict EMAILCO data. TTL is still
   * per-entry.
   *
   * `buildFn` gets both the resolved jql string AND the project
   * key, so builders that need project-scoped scalars (e.g. kanban
   * columns) can pull them via resolveProjectScalar.
   */
  function makeCachedBuilder({ ttlMs, buildFn, widgetKey, reasonNoJql }) {
    const caches = new Map(); // projectKey|"" → { payload, fetchedAt }
    const getter = async function ({ force = false, project } = {}) {
      const key = project ?? "";
      const entry = caches.get(key);
      if (
        !force &&
        entry &&
        entry.payload &&
        Date.now() - entry.fetchedAt < ttlMs
      ) {
        return entry.payload;
      }
      const jira = jiraFromEnv();
      const { jql: baseJql, source, fallbackFrom } = resolveJql(
        process.env,
        project,
        widgetKey
      );
      if (!jira || !baseJql) {
        return {
          unavailable: true,
          project: project ?? null,
          reason: !jira
            ? "JIRA_BASE_URL / JIRA_TOKEN not set"
            : `${source} not set`,
          source,
          fallbackFrom,
          generatedAt: Date.now(),
        };
      }
      // Layer the team-scope exclusions (Avast Freemium etc.) onto the
      // resolved JQL so every widget — not just kanban — shows just
      // Norton Email's work. Driven by JIRA_<PROJECT>_EXCLUDE_* env
      // vars; a no-op when those are unset.
      const { jql, applied: teamScopeApplied } = applyTeamScope(
        baseJql,
        process.env,
        project
      );
      const payload = await buildFn({ jira, jql, project });
      const withMeta = {
        ...payload,
        project: project ?? null,
        jqlSource: source,
        jqlFallbackFrom: fallbackFrom,
        teamScopeApplied,
      };
      caches.set(key, { payload: withMeta, fetchedAt: Date.now() });
      return withMeta;
    };
    getter.ttlMs = ttlMs;
    return getter;
  }

  /* Per-project scalars: resolved at request time so a JQL-only
   * config change (restart) picks up new values without a code
   * change here. These closures capture only the project key. */
  function kanbanOptsFor(project) {
    const columns = perProjectList(project, "KANBAN_COLUMNS", []).value;
    const boardUrl = perProjectScalar(project, "KANBAN_URL", "").value || null;
    return { columns, boardUrl };
  }
  function lifecycleOptsFor(project) {
    return {
      lookbackDays: perProjectNumber(project, "LIFECYCLE_LOOKBACK_DAYS", 30)
        .value,
      jqlPrevious: resolveJql(process.env, project, "LIFECYCLE_PREV").jql,
    };
  }
  function topPriorityOptsFor(project) {
    return {
      priorities: perProjectList(project, "TOP_PRIORITIES", [
        "Highest",
        "Critical",
        "High",
      ]).value,
      status: perProjectScalar(project, "TOP_PRIORITY_STATUS", "To Do").value,
      limit: perProjectNumber(project, "TOP_PRIORITY_LIMIT", 6).value,
    };
  }
  function sprintBacklogOptsFor(project) {
    return {
      status: perProjectScalar(project, "SPRINT_BACKLOG_STATUS", "To Do").value,
      boardUrl: kanbanOptsFor(project).boardUrl,
    };
  }
  function reopenOptsFor(project) {
    return {
      doneStatuses: perProjectList(project, "DONE_STATUSES", [
        "Done",
        "Closed",
        "Resolved",
      ]).value,
      windowDays: perProjectNumber(project, "REOPEN_WINDOW_DAYS", 30).value,
    };
  }
  function leaderboardOptsFor(project) {
    return {
      limit: perProjectNumber(project, "LEADERBOARD_LIMIT", 6).value,
    };
  }

  const getThroughput = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    widgetKey: "THROUGHPUT",
    buildFn: ({ jira, jql }) => buildWeeklyThroughput({ jira, jql, timezone }),
  });

  const getBacklog = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    widgetKey: "BACKLOG",
    buildFn: ({ jira, jql }) => buildBacklogOverview({ jira, jql, timezone }),
  });

  const getLifecycle = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    widgetKey: "LIFECYCLE",
    buildFn: ({ jira, jql, project }) => {
      const o = lifecycleOptsFor(project);
      // The "previous period" JQL comes from its own env var
      // (LIFECYCLE_PREV_JQL) and is NOT routed through
      // applyTeamScope() by makeCachedBuilder — that wrapper only
      // scopes the primary JQL. Without this, the current period
      // would be team-scoped (Norton EMAIL only) while the previous
      // period leaks in cross-team tickets, producing a misleading
      // delta. Apply the same exclusion + INCLUDE_BUSINESS_TEAMS
      // scope explicitly here so both halves of the comparison are
      // measured against the identical population.
      const jqlPreviousScoped = o.jqlPrevious
        ? applyTeamScope(o.jqlPrevious, process.env, project).jql
        : undefined;
      return buildTicketLifecycle({
        jira,
        jql,
        jqlPrevious: jqlPreviousScoped,
        lookbackDays: o.lookbackDays,
        timezone,
      });
    },
  });

  const getKanban = makeCachedBuilder({
    ttlMs: VERY_SHORT_TTL_MS,
    widgetKey: "KANBAN",
    buildFn: ({ jira, jql, project }) => {
      const o = kanbanOptsFor(project);
      return buildKanbanBoard({
        jira,
        jql,
        columns: o.columns.length > 0 ? o.columns : null,
        timezone,
        boardUrl: o.boardUrl,
      });
    },
  });

  const getInflow = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    widgetKey: "INFLOW",
    buildFn: ({ jira, jql }) => buildInflowVsResolved({ jira, jql, timezone }),
  });

  const getSlaRisk = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    widgetKey: "SLA",
    buildFn: ({ jira, jql }) =>
      buildSlaAgingRisk({ jira, jql, thresholds: slaThresholds, timezone }),
  });

  const getTopPriority = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    widgetKey: "TOP_PRIORITY",
    buildFn: ({ jira, jql, project }) => {
      const o = topPriorityOptsFor(project);
      return buildTopPriorityTickets({
        jira,
        jql,
        priorities: o.priorities,
        status: o.status,
        topN: o.limit,
        timezone,
      });
    },
  });

  const getSprintBacklog = makeCachedBuilder({
    ttlMs: SHORT_TTL_MS,
    widgetKey: "SPRINT_BACKLOG",
    buildFn: ({ jira, jql, project }) => {
      const o = sprintBacklogOptsFor(project);
      return buildSprintBacklog({
        jira,
        jql,
        status: o.status,
        boardUrl: o.boardUrl,
        timezone,
      });
    },
  });

  const getReopenRate = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    widgetKey: "REOPEN",
    buildFn: ({ jira, jql, project }) => {
      const o = reopenOptsFor(project);
      return buildReopenRate({
        jira,
        jql,
        doneStatuses: o.doneStatuses,
        windowDays: o.windowDays,
        timezone,
      });
    },
  });

  const getThroughputLeaderboard = makeCachedBuilder({
    ttlMs: MEDIUM_TTL_MS,
    widgetKey: "LEADERBOARD",
    buildFn: ({ jira, jql, project }) => {
      const o = leaderboardOptsFor(project);
      return buildThroughputLeaderboard({
        jira,
        jql,
        topN: o.limit,
        timezone,
      });
    },
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
      // Disable caching on the dashboard HTML so UI changes
      // (new widgets, new overlays, copy tweaks) land on refresh
      // instead of silently persisting as stale desktop cache.
      // The HTML is tiny (~KB) and server-rendered per request
      // anyway — caching buys us nothing and costs demo reliability.
      res.set("Cache-Control", "no-store, no-cache, must-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
      res.type("text/html").send(rendered);
    });
  });

  router.get("/healthz", (req, res) => {
    res.type("text/plain").send("ok");
  });

  /* ---------------------------------------------------------------- *
   * Azure AD SSO routes.
   *
   * These are always registered so the URLs are stable for Azure app
   * registration metadata, but they only DO anything when OIDC
   * discovery has resolved successfully. Before that (boot race, or
   * AUTH_STRATEGY !== oidc) they return 503 with a clear reason.
   * ---------------------------------------------------------------- */
  function oidcOrFail(res) {
    if (oidcConfig) return true;
    res.statusCode = 503;
    res.type("text/plain").send(
      authStrategyEnv === "oidc"
        ? "SSO is warming up or misconfigured — check server logs for an [auth] line."
        : "SSO is not enabled on this instance. Set AUTH_STRATEGY=oidc + OIDC_* env vars to enable."
    );
    return false;
  }

  router.get("/auth/login", async (req, res, next) => {
    if (!oidcOrFail(res)) return;
    try {
      await startLoginRedirect(oidcConfig, req, res);
    } catch (err) {
      next(err);
    }
  });

  // Mock-OIDC callback: the demo login form POSTs back here with the
  // chosen display name / email / roles. No-op (404) when real OIDC
  // is active, since Azure never POSTs to /auth/login.
  router.post("/auth/login", async (req, res, next) => {
    if (!oidcOrFail(res)) return;
    if (!oidcConfig?.mock) {
      res.statusCode = 405;
      res.type("text/plain").send("POST /auth/login is only available in mock mode.");
      return;
    }
    try {
      await completeMockLogin(oidcConfig, req, res);
    } catch (err) {
      next(err);
    }
  });

  router.get("/auth/callback", async (req, res, next) => {
    if (!oidcOrFail(res)) return;
    try {
      await finishLoginCallback(oidcConfig, req, res);
    } catch (err) {
      next(err);
    }
  });

  // Accept both GET (convenience — clickable link) and POST
  // (belt-and-braces CSRF protection for the button in the UI).
  router.get("/auth/logout", (req, res) => {
    if (!oidcConfig) {
      res.redirect("/");
      return;
    }
    performLogout(oidcConfig, req, res);
  });
  router.post("/auth/logout", (req, res) => {
    if (!oidcConfig) {
      res.redirect("/");
      return;
    }
    performLogout(oidcConfig, req, res);
  });

  // Lightweight status probe for the dashboard UI. Unauthenticated on
  // purpose — it only reveals whether OIDC is ON, never anything
  // user-specific. The real "who am I" answer lives at /api/me.
  router.get("/auth/status", (_req, res) => {
    const ssoPending = !oidcConfig && (authStrategyEnv === "oidc" || authStrategyEnv === "mock-oidc");
    res.json({
      strategy: oidcConfig ? "oidc" : ssoPending ? "oidc-pending" : "shared-key",
      mock: Boolean(oidcConfig?.mock),
      loginUrl: "/auth/login",
      logoutUrl: "/auth/logout",
      enabled: Boolean(oidcConfig),
    });
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
      // New presence models route through src/presence/*. Legacy bot
      // mode keeps the SQLite check-in + rollcall flow exactly as
      // before so flipping the flag is a zero-risk reversal.
      //
      // We also take this path when ONLY Workday is wired (no Slack
      // yet) so the team grid still gets vacation overlays today —
      // otherwise users see an empty roster until the Slack admin
      // approves the app, which can be days or weeks away.
      if (
        (presenceUsesSlack && slackPresenceProvider) ||
        (presenceUsesWorkday && workdayPresenceProvider)
      ) {
        const payload = await buildTeamPayloadFromProviders();
        res.json(payload);
        return;
      }

      const payload = await buildTeamPayloadFromBot();
      res.json(payload);
    } catch (err) {
      console.error("[web] /api/team failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  /* ---------------------------------------------------------------- *
   * /api/absences — who's out today and in the next N days.
   *
   * Drives the "Out today" hero strip + "Out next 7 days" carousel.
   * Source is WORKDAY_PROVIDER (csv, ical, rest). When the flag is
   * off (bot mode or workday=noop) this returns empty lists — the UI
   * hides the strips automatically.
   *
   * Privacy note: the `type` field IS returned here (PTO / Sick /
   * ...). The web UI is responsible for showing it only in
   * manager/director views (filter drawer). Public cards label
   * everything as "Vacation".
   * ---------------------------------------------------------------- */
  router.get("/api/absences", async (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const days = Math.max(
        1,
        Math.min(30, Number(req.query?.days ?? 7) || 7)
      );

      if (!presenceUsesWorkday || !workdayPresenceProvider) {
        res.json({
          generatedAt: Date.now(),
          model: presenceModel,
          source: workdayPresenceProvider?.kind ?? "none",
          windowDays: days,
          today: [],
          upcoming: [],
          totals: { today: 0, upcoming: 0 },
        });
        return;
      }

      // Roster enriched with emails we've already resolved this session.
      const identitiesBySlackId = new Map();
      for (const [uid, payload] of identityCache) {
        if (payload?.payload) identitiesBySlackId.set(uid, payload.payload);
      }

      const all = await listUpcomingAbsences({
        workdayProvider: workdayPresenceProvider,
        days,
        roster: TEAM,
        identitiesBySlackId,
      });

      const todayYmd = todayInTz();
      const today = all.filter(
        (a) => todayYmd >= a.startDate && todayYmd <= a.endDate
      );
      const upcoming = all.filter((a) => a.startDate > todayYmd);

      res.json({
        generatedAt: Date.now(),
        model: presenceModel,
        source: workdayPresenceProvider.kind ?? "none",
        windowDays: days,
        today,
        upcoming,
        totals: { today: today.length, upcoming: upcoming.length },
      });
    } catch (err) {
      console.error("[web] /api/absences failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  /* ---------------------------------------------------------------- *
   * Legacy (bot-driven) team payload. Unchanged from the original
   * implementation — see git history for the rationale behind each
   * field. Invoked only when PRESENCE_MODEL=bot (the default).
   * ---------------------------------------------------------------- */
  async function buildTeamPayloadFromBot() {
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

    return {
      brandName,
      date,
      timezone,
      generatedAt: Date.now(),
      model: "bot",
      models: { bot: true, slack: false, workday: false },
      members,
      rollcalls,
    };
  }

  /* ---------------------------------------------------------------- *
   * Provider-driven team payload (PRESENCE_MODEL=slack[+workday]).
   *
   * Shape stays identical to the bot payload so the UI doesn't need a
   * second code path, PLUS two new fields on each member:
   *
   *   slackStatus: {
   *     bucket,           // BUCKETS.*
   *     reason,           // human-readable provenance
   *     line,             // formatted "emoji text" or null
   *     emoji, text,
   *     expiration,       // UNIX seconds
   *     autoPresence,     // "active" | "away" | null
   *     source,           // "slack" | "workday" | "none"
   *   }
   *   workday: { type, through } | null
   *
   * The `checkin`/`presence` fields are preserved (set to null when
   * running off providers) so the UI's existing code paths degrade to
   * "use the new slackStatus field instead" without extra branching.
   * ---------------------------------------------------------------- */
  async function buildTeamPayloadFromProviders() {
    const date = todayInTz();

    // Seed: start from the explicit roster (source of truth) plus any
    // TEAM_MEMBER_IDS override. We intentionally do NOT pull from the
    // "recently interacted with the bot" table — in slack mode we
    // want the roster to be complete from day one, not dependent on
    // past bot use.
    const rosterIds = TEAM.flatMap((m) => m.slackIds ?? []);
    const memberIds = Array.from(
      new Set([...seedMemberIds, ...rosterIds].filter(Boolean))
    );

    // Build identity first so we have email (needed for Workday CSV
    // matching) and display names in one place.
    const identities = await Promise.all(memberIds.map((u) => loadIdentity(u)));
    const identityById = new Map();
    const emailByUserId = new Map();
    identities.forEach((id, i) => {
      const uid = memberIds[i];
      if (id) {
        identityById.set(uid, id);
        if (id.email) emailByUserId.set(uid, id.email);
      }
    });

    // Build slug lookup so the Workday CSV can match by roster slug
    // (works even before anyone's Slack id is wired up in team.js).
    const slugByUserId = new Map();
    for (const uid of memberIds) {
      const entry = findBySlackId(uid);
      if (entry?.slug) slugByUserId.set(uid, entry.slug);
    }

    // Feed resolvePresence a noop slack shim when Slack isn't wired
    // yet — the aggregator requires *some* slackProvider to key off,
    // and falling back to UNKNOWN for every user is correct in that
    // state. Workday overlays still win (see presence/index.js).
    const slackProviderForResolve = slackPresenceProvider ?? {
      async fetchPresenceForUsers() {
        return new Map();
      },
    };
    const presenceByUser =
      slackPresenceProvider || workdayPresenceProvider
        ? await resolvePresence({
            userIds: memberIds,
            slackProvider: slackProviderForResolve,
            workdayProvider: workdayPresenceProvider ?? undefined,
            emailByUserId,
            slugByUserId,
          })
        : new Map();

    // Workday-only overlay for roster members NOT yet mapped to a
    // Slack id. resolvePresence above only checks Workday for users
    // it has a slackId for, so when Slack isn't wired the whole team
    // falls through the fallback path below with workday=null — and
    // Kristýna-on-PTO would look "available". Here we fetch today's
    // active absences once and index by slug so the fallback loop can
    // attach a Vacation badge without double-fetching.
    const activeWorkdayBySlug = new Map();
    if (workdayPresenceProvider) {
      try {
        const todayY = todayInTz();
        const activeRows = await listUpcomingAbsences({
          workdayProvider: workdayPresenceProvider,
          days: 1,
          roster: TEAM,
        });
        for (const r of activeRows) {
          if (!r.slug) continue;
          if (todayY >= r.startDate && todayY <= r.endDate) {
            activeWorkdayBySlug.set(r.slug, r);
          }
        }
      } catch (err) {
        console.warn("[web] Workday today-overlay skipped:", err?.message);
      }
    }

    const members = memberIds.map((userId) => {
      const identity = identityById.get(userId) ?? null;
      const rosterEntry = findBySlackId(userId);
      const presence = presenceByUser.get(userId) ?? null;
      const name = identity?.displayName || rosterEntry?.displayName || userId;
      return {
        id: userId,
        name,
        avatarUrl: identity?.avatarUrl ?? rosterEntry?.avatarUrl ?? null,
        initials:
          identity?.initials ?? initialsFor(rosterEntry?.fullName ?? name),
        title: identity?.title ?? rosterEntry?.title ?? null,
        role: rosterEntry?.role ?? null,
        team: rosterEntry?.team ?? null,
        tags: rosterEntry?.tags ?? [],
        // Preserve legacy shape so the existing UI renderers keep working.
        checkin: null,
        presence: null,
        // New presence fields — the UI uses these when they're present.
        slackStatus: presence
          ? {
              bucket: presence.bucket,
              reason: presence.reason,
              line: presence.statusLine,
              emoji: presence.statusEmoji,
              text: presence.statusText,
              expiration: presence.statusExpiration,
              autoPresence: presence.autoPresence,
              source: presence.source,
            }
          : {
              bucket: BUCKETS.UNKNOWN,
              reason: "provider unavailable",
              line: null,
              emoji: "",
              text: "",
              expiration: 0,
              autoPresence: null,
              source: "none",
            },
        workday:
          presence && presence.source === "workday"
            ? { type: presence.vacationType, through: presence.through }
            : null,
      };
    });

    // Any roster members who aren't yet mapped to a live Slack id get
    // appended as read-only rows (no status) so the card list stays
    // complete.
    const seenNames = new Set(members.map((m) => m.name.toLowerCase()));
    for (const fallback of rosterFallbackMembers()) {
      if (!seenNames.has(fallback.name.toLowerCase())) {
        // If the CSV says this person is out today, overlay Vacation
        // even though we don't have a Slack id for them yet. This is
        // the bridge between "Workday works" (today) and "Slack works
        // too" (after workspace admin approves).
        const wd = fallback.slug
          ? activeWorkdayBySlug.get(fallback.slug)
          : null;
        members.push({
          ...fallback,
          slackStatus: wd
            ? {
                bucket: BUCKETS.VACATION,
                reason: `Workday ${wd.type} through ${wd.endDate}`,
                line: null,
                emoji: "",
                text: "",
                expiration: 0,
                autoPresence: null,
                source: "workday",
              }
            : {
                bucket: BUCKETS.UNKNOWN,
                reason: "not mapped to a Slack user id yet",
                line: null,
                emoji: "",
                text: "",
                expiration: 0,
                autoPresence: null,
                source: "none",
              },
          workday: wd ? { type: wd.type, through: wd.endDate } : null,
        });
      }
    }

    members.sort((a, b) => a.name.localeCompare(b.name));

    return {
      brandName,
      date,
      timezone,
      generatedAt: Date.now(),
      model: presenceModel,
      models: {
        bot: false,
        slack: presenceUsesSlack,
        workday: presenceUsesWorkday,
      },
      members,
      // Rollcalls are a bot-mode concept; empty in provider mode so
      // the UI can cleanly hide that section when the new model is
      // active.
      rollcalls: [],
    };
  }

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
        // Carry the slug through so the Workday overlay can match
        // by slug (src/presence/index.js indexes this way when we
        // don't yet have a Slack id for the roster member).
        slug: m.slug,
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
    const authResult = currentAuthenticator.authenticate(req);
    if (!authResult.ok) {
      // For /api/me specifically, prefer a 200 with `signedIn=false`
      // over a 401. The dashboard polls this to decide "show Sign In
      // button vs. show user pill" — 401 would noisy-up the console
      // and force conditional-catch boilerplate in the client.
      const ssoPending = !oidcConfig && (authStrategyEnv === "oidc" || authStrategyEnv === "mock-oidc");
      res.json({
        signedIn: false,
        auth: oidcConfig ? "oidc" : ssoPending ? "oidc-pending" : "shared-key",
        mock: Boolean(oidcConfig?.mock),
        loginUrl: oidcConfig ? "/auth/login" : null,
      });
      return;
    }
    const user = authResult.user;
    // If OIDC gave us real claims, prefer them verbatim — that's the
    // whole point of SSO. Otherwise fall back to Slack-profile
    // lookup via team roster (the existing shared-key path).
    if (user.sub?.startsWith("oidc:")) {
      const name = user.displayName ?? user.email ?? "Signed in";
      const firstName = (name.split(/\s+/)[0] ?? name).trim();
      const parts = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("");
      res.json({
        signedIn: true,
        auth: "oidc",
        mock: Boolean(oidcConfig?.mock),
        userId: user.sub,
        roles: user.roles ?? [],
        displayName: user.displayName ?? null,
        firstName,
        title: (user.roles ?? []).includes("manager")
          ? "Manager"
          : (user.roles ?? []).includes("director")
          ? "Director"
          : null,
        email: user.email ?? null,
        avatarUrl: null, // Azure doesn't return a URL in the ID token; Graph call if we ever need one
        initials: parts || null,
        profileUrl: null,
        canCustomize:
          (user.roles ?? []).includes("manager") ||
          (user.roles ?? []).includes("admin"),
        logoutUrl: "/auth/logout",
      });
      return;
    }
    // Shared-key (anonymous) path — keep the legacy Slack-derived
    // identity shape so the existing UI keeps working.
    const userId = callerUserId(req);
    const roles = Array.from(callerRoles(req));
    const identity = await loadIdentity(userId);
    res.json({
      signedIn: false, // not SSO-signed-in; still dashboard-authorised
      auth: "shared-key",
      mock: false,
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
      loginUrl: oidcConfig ? "/auth/login" : null,
    });
  });

  /* ---------------------------------------------------------------- *
   * /api/demo-url
   *
   * Surfaces the *current* public URL of the ephemeral Cloudflare
   * quick-tunnel (if any) to the dashboard UI, so the operator can
   * copy-paste a shareable link without hunting through a terminal.
   *
   * The URL is written by scripts/tunnel-watchdog.sh into
   * data/tunnel-state.json whenever cloudflared announces one; this
   * endpoint just reads that file. It's always safe to call —
   * returns `{ status: "down", url: null }` if no tunnel is active.
   *
   * Auth gate: we require the normal dashboard auth because the
   * read-only URL includes the shared dashboard key. Anonymous
   * callers get 401, same as every other /api/* route.
   * ---------------------------------------------------------------- */
  router.get("/api/demo-url", (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const state = readTunnelState();
    const { publicUrl, readOnlyUrl } = buildShareLinks({
      publicUrl: state.url,
      dashboardKey,
    });
    // No-store because the URL rotates on tunnel restart. We don't
    // want a 5-minute desktop cache serving an address that hangs up
    // in the middle of a demo.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      status: state.status,
      publicUrl: publicUrl ?? null,
      readOnlyUrl: readOnlyUrl ?? null,
      localUrl: state.localUrl,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      hasSharedKey: Boolean(dashboardKey),
    });
  });

  router.get("/api/weather", async (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!weatherService) {
      // Return 200 with {enabled:false} rather than 404 so the client
      // can just hide the chip without logging a network error.
      res.set("Cache-Control", "no-store");
      res.json({ enabled: false });
      return;
    }
    try {
      const reading = await weatherService.getCurrent();
      if (!reading) {
        res.set("Cache-Control", "no-store");
        res.json({ enabled: true, available: false });
        return;
      }
      // 5-min browser cache — half the server TTL — so tabs left
      // open don't hammer the endpoint, but the UI still picks up
      // fresh data within one refresh cycle of a real change.
      res.set("Cache-Control", "public, max-age=300");
      res.json({ enabled: true, available: true, ...reading });
    } catch (err) {
      console.warn("[weather] route error:", err?.message ?? err);
      res.status(200).json({ enabled: true, available: false });
    }
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
  // Provisional filter marker — flipped to true by the scrum master
  // once they've signed off on JQL per widget. Until then, every Jira
  // widget's filter chip carries a subtle "Provisional" badge so
  // viewers (especially execs) know the numbers are live data but
  // the filters themselves are pre-approval.
  const jiraFiltersApproved =
    (process.env.JIRA_FILTERS_APPROVED ?? "")
      .toString()
      .trim()
      .toLowerCase();
  const filtersAreProvisional =
    !jiraFiltersApproved ||
    jiraFiltersApproved === "0" ||
    jiraFiltersApproved === "false" ||
    jiraFiltersApproved === "no";

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
      const { key: project, error: projectError } = normaliseProject(req);
      if (projectError) {
        res.status(400).json({ error: projectError });
        return;
      }
      try {
        const payload = await getter({
          force: req.query?.force === "1",
          project,
        });
        let filter = null;
        if (buildFilterMeta && !payload?.unavailable) {
          try {
            filter = buildFilterMeta(payload, project);
            if (filter && filtersAreProvisional) {
              filter = { ...filter, provisional: true };
            }
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
   * Filter-meta builders per widget.
   *
   * The filter drawer needs: the executed JQL, which env var supplied
   * it (so CSM teams can tell where to edit), any fallback that fired,
   * and the widget-specific parameters (lookback days, thresholds,
   * etc.). All of those are now project-aware — the env-var source
   * string includes the project prefix (`JIRA_EMOPS_THROUGHPUT_JQL`)
   * so the drawer UX immediately tells the operator which line in
   * `.env` to edit.
   * ------------------------------------------------------------------ */

  registerWidgetRoute("weekly-throughput", getThroughput, (p) =>
    filterForWeeklyThroughput({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getThroughput.ttlMs / 1000),
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
      weeksOfTrend: p?.weeksOfTrend,
    })
  );
  registerWidgetRoute("backlog-overview", getBacklog, (p) =>
    filterForBacklogOverview({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getBacklog.ttlMs / 1000),
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    })
  );
  registerWidgetRoute("ticket-lifecycle", getLifecycle, (p, project) => {
    const o = lifecycleOptsFor(project);
    return filterForTicketLifecycle({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getLifecycle.ttlMs / 1000),
      lookbackDays: o.lookbackDays,
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    });
  });
  registerWidgetRoute("inflow-vs-resolved", getInflow, (p) =>
    filterForInflowVsResolved({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getInflow.ttlMs / 1000),
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    })
  );
  registerWidgetRoute("sla-aging-risk", getSlaRisk, (p) =>
    filterForSlaAgingRisk({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getSlaRisk.ttlMs / 1000),
      thresholds: slaThresholds,
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    })
  );
  registerWidgetRoute("sprint-backlog", getSprintBacklog, (p, project) => {
    const o = sprintBacklogOptsFor(project);
    return filterForSprintBacklog({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getSprintBacklog.ttlMs / 1000),
      status: o.status,
      boardUrl: o.boardUrl,
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    });
  });
  registerWidgetRoute("reopen-rate", getReopenRate, (p, project) => {
    const o = reopenOptsFor(project);
    return filterForReopenRate({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getReopenRate.ttlMs / 1000),
      doneStatuses: o.doneStatuses,
      windowDays: o.windowDays,
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    });
  });
  registerWidgetRoute("top-priority-tickets", getTopPriority, (p, project) => {
    const o = topPriorityOptsFor(project);
    return filterForTopPriority({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getTopPriority.ttlMs / 1000),
      priorities: o.priorities,
      status: o.status,
      limit: o.limit,
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    });
  });
  registerWidgetRoute(
    "throughput-leaderboard",
    getThroughputLeaderboard,
    (p, project) => {
      const o = leaderboardOptsFor(project);
      return filterForThroughputLeaderboard({
        jql: p?.jql ?? "",
        source: p?.jqlSource,
        fallbackFrom: p?.jqlFallbackFrom,
        refreshSeconds: Math.round(getThroughputLeaderboard.ttlMs / 1000),
        limit: o.limit,
        timezone,
        generatedAt: p?.generatedAt,
        project: p?.project,
      });
    }
  );
  registerWidgetRoute("kanban-board", getKanban, (p, project) => {
    const o = kanbanOptsFor(project);
    return filterForKanban({
      jql: p?.jql ?? "",
      source: p?.jqlSource,
      fallbackFrom: p?.jqlFallbackFrom,
      refreshSeconds: Math.round(getKanban.ttlMs / 1000),
      columns: o.columns,
      boardUrl: o.boardUrl,
      timezone,
      generatedAt: p?.generatedAt,
      project: p?.project,
    });
  });

  /* ---------------------------------------------------------------- *
   * /api/jira-projects — tells the UI which project tabs to render.
   *
   * The client reads this on page load to populate the project
   * switcher (see public/index.html). When the deployment is
   * single-project (no JIRA_PROJECT_KEYS) we return an empty list
   * and the switcher hides itself.
   * ---------------------------------------------------------------- */
  router.get("/api/jira-projects", (req, res) => {
    if (!authorized(req, dashboardKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({
      projects: configuredProjects,
      defaultProject: fallbackProjectKey,
      allProjectKey: ALL_PROJECT_KEY,
    });
  });

  console.log(
    `[web] dashboard enabled at / — ${dashboardKey ? "key required" : "no key (dev only)"}`
  );
}
