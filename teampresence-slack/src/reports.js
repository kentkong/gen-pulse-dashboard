/**
 * Weekly-throughput report builder.
 *
 * All dates are computed in Europe/Prague (or whatever TEAM_TIMEZONE is set to)
 * so "last week" means the full Mon..Sun that ended before this week.
 */

// How many completed weeks of history to render on the throughput /
// inflow-vs-resolved / leaderboard trend charts.
//
// Default 12 — matches the Norton EMAIL Reports Jira dashboard the team
// is already used to reading. Override per-deploy with
// JIRA_WIDGET_WEEKS_OF_TREND in .env (e.g. set to 8 to go back to the
// previous default, or 26 for a ~6-month view).
const WEEKS_OF_TREND = (() => {
  const raw = (process.env.JIRA_WIDGET_WEEKS_OF_TREND ?? "").trim();
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 52 ? parsed : 12;
})();

/** ISO week label like "2026-W15" for a given UTC ms timestamp. */
function isoWeekLabel(ms) {
  const d = new Date(ms);
  // Thursday of this week determines ISO year/week
  const target = new Date(d.getTime());
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() + 4 - (firstThursday.getUTCDay() || 7)
  );
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** YYYY-MM-DD in the given IANA timezone for a Date. */
function tzDate(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

/** Monday (00:00) at the start of the ISO week containing `ref`, in `timezone`. */
function mondayOfWeek(ref, timezone) {
  // Start from ref's date in the target tz, walk back to Monday.
  const dayName = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
  }).format(ref);
  const order = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = order[dayName] ?? 0;
  const ms = ref.getTime() - offset * 24 * 3600 * 1000;
  const ymd = tzDate(new Date(ms), timezone);
  return `${ymd} 00:00`;
}

/** Add N days to a `YYYY-MM-DD HH:mm` string (no tz conversion, just arithmetic). */
function addDays(dayStr, n) {
  const [date, hhmm] = dayStr.split(" ");
  const d = new Date(`${date}T${hhmm ?? "00:00"}:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day} ${hhmm ?? "00:00"}`;
}

/** Human-friendly "Apr 7 – Apr 13" from a `YYYY-MM-DD HH:mm` start and end. */
function prettyWeekRange(startStr, endStr) {
  const fmt = (s) =>
    new Date(`${s.split(" ")[0]}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return `${fmt(startStr)} – ${fmt(endStr)}`;
}

/**
 * Build the throughput payload for a given anchor Date.
 *
 * - "last week"     = the most recently completed Mon..Sun relative to `now`
 * - "prev week"     = the Mon..Sun before that
 * - trend           = the last N completed weeks' totals, oldest -> newest
 */
export async function buildWeeklyThroughput({
  jira,
  jql,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
  now = new Date(),
  weeksOfTrend = WEEKS_OF_TREND,
}) {
  if (!jira) throw new Error("buildWeeklyThroughput: jira client required");
  if (!jql) throw new Error("buildWeeklyThroughput: jql required");

  const thisMonday = mondayOfWeek(now, timezone);
  const lastMonday = addDays(thisMonday, -7);
  const prevMonday = addDays(lastMonday, -7);
  const lastSunday23 = addDays(lastMonday, 7);
  const prevSunday23 = addDays(prevMonday, 7);

  const withinJql = (from, to) =>
    `(${jql}) AND resolved >= "${from}" AND resolved < "${to}"`;

  const [resolved, previous] = await Promise.all([
    jira.searchCount(withinJql(lastMonday, lastSunday23)),
    jira.searchCount(withinJql(prevMonday, prevSunday23)),
  ]);

  // Trend: N most recent completed weeks (oldest first), ending with "last week".
  const trendPromises = [];
  const trendLabels = [];
  for (let i = weeksOfTrend - 1; i >= 0; i--) {
    const from = addDays(lastMonday, -7 * i);
    const to = addDays(from, 7);
    trendPromises.push(jira.searchCount(withinJql(from, to)));
    trendLabels.push(isoWeekLabel(new Date(`${from.split(" ")[0]}T00:00:00Z`)));
  }
  const trend = await Promise.all(trendPromises);

  const deltaAbs = resolved - previous;
  const deltaPct =
    previous > 0 ? (deltaAbs / previous) * 100 : resolved > 0 ? 100 : 0;

  return {
    weekLabel: isoWeekLabel(
      new Date(`${lastMonday.split(" ")[0]}T00:00:00Z`)
    ),
    weekRange: prettyWeekRange(lastMonday, addDays(lastMonday, 6)),
    resolved,
    previous,
    deltaAbs,
    deltaPct: Math.round(deltaPct * 10) / 10,
    trend,
    trendLabels,
    generatedAt: Date.now(),
    timezone,
    jql,
  };
}

const PRIORITY_ORDER = ["Highest", "Critical", "High", "Medium", "Low", "Lowest"];

function sortPriorities(entries) {
  const rank = (p) => {
    const i = PRIORITY_ORDER.indexOf(p);
    return i === -1 ? 999 : i;
  };
  return [...entries].sort((a, b) => rank(a.priority) - rank(b.priority));
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Backlog overview — snapshot of currently open work.
 *
 * Expects `jql` to describe "all open EMAIL tickets", e.g.
 *   project = EMAIL AND statusCategory != Done
 * The builder adds the priority / age filters on top.
 */
export async function buildBacklogOverview({
  jira,
  jql,
  // Default priorities match Gen's EMOPS / EMAILCO schemes (P0–P4).
  // Legacy Jira's Highest/Critical/High are still included so the
  // widget degrades gracefully on instances that haven't migrated.
  priorities = ["P0", "P1", "P2", "P3", "P4", "Highest", "Critical", "High", "Medium", "Low", "Lowest"],
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
}) {
  if (!jira) throw new Error("buildBacklogOverview: jira client required");
  if (!jql) throw new Error("buildBacklogOverview: jql required");

  // `newThisWeek` needs to count EVERY ticket that arrived in the
  // last 7 days, even tickets that were opened *and* closed within
  // the same week (otherwise the widget silently drops same-week
  // churn and the displayed "new" number is just `total - previous`
  // again, which is redundant).
  //
  // The base JQL filters to `statusCategory != Done` so it only
  // enumerates still-open work; we strip that clause (and the
  // preceding AND so the query stays syntactically valid) before
  // layering the `created >= -7d` window on top. If the base JQL
  // doesn't contain the clause the replace is a no-op — which is
  // fine because nothing was excluded in the first place.
  //
  // `resolvedThisWeek` goes the other way: flip the clause to
  // `statusCategory = Done` so we count only tickets that reached
  // done during the window.
  const inflowJql = `(${jql.replace(
    /\s+AND\s+statusCategory\s*!=\s*Done/i,
    ""
  )}) AND created >= -7d`;
  const resolvedWeekJql = `(${jql.replace(
    /statusCategory\s*!=\s*Done/i,
    "statusCategory = Done"
  )}) AND resolved >= -7d`;

  const [total, previous, newThisWeek, resolvedThisWeek] = await Promise.all([
    jira.searchCount(`(${jql})`),
    jira.searchCount(`(${jql}) AND created <= -7d`),
    jira.searchCount(inflowJql),
    jira.searchCount(resolvedWeekJql),
  ]);

  const byPriorityCounts = await Promise.all(
    priorities.map((p) =>
      jira.searchCount(`(${jql}) AND priority = "${p}"`).then((count) => ({
        priority: p,
        count,
      }))
    )
  );
  const byPriority = sortPriorities(byPriorityCounts.filter((x) => x.count > 0));

  const [ageNew, ageRecent, ageAging, ageStale] = await Promise.all([
    jira.searchCount(`(${jql}) AND created >= -7d`),
    jira.searchCount(`(${jql}) AND created >= -30d AND created < -7d`),
    jira.searchCount(`(${jql}) AND created >= -90d AND created < -30d`),
    jira.searchCount(`(${jql}) AND created < -90d`),
  ]);

  const deltaAbs = total - previous;
  const deltaPct = previous > 0 ? round1((deltaAbs / previous) * 100) : 0;

  return {
    total,
    previous,
    deltaAbs,
    deltaPct,
    byPriority,
    byAge: { new: ageNew, recent: ageRecent, aging: ageAging, stale: ageStale },
    newThisWeek,
    resolvedThisWeek,
    generatedAt: Date.now(),
    timezone,
    jql,
  };
}

/**
 * Ticket lifecycle — how long does a ticket live, from created to resolved?
 *
 * Expects `jql` to describe "tickets resolved in the recent window":
 *   project = EMAIL AND statusCategory = Done AND resolved >= -30d
 */
export async function buildTicketLifecycle({
  jira,
  jql,
  jqlPrevious, // optional: same query for the preceding window
  lookbackDays = 30,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
}) {
  if (!jira) throw new Error("buildTicketLifecycle: jira client required");
  if (!jql) throw new Error("buildTicketLifecycle: jql required");

  const issues = await jira.searchAll(jql, {
    fields: ["created", "resolutiondate", "priority"],
    pageSize: 100,
    hardCap: 500,
  });

  const agesDays = [];
  const byPriorityBuckets = new Map();
  for (const iss of issues) {
    const created = iss.fields?.created;
    const resolved = iss.fields?.resolutiondate;
    if (!created || !resolved) continue;
    const days = (Date.parse(resolved) - Date.parse(created)) / 86_400_000;
    if (!Number.isFinite(days) || days < 0) continue;
    agesDays.push(days);
    const p = iss.fields?.priority?.name ?? "Unprioritised";
    if (!byPriorityBuckets.has(p)) byPriorityBuckets.set(p, []);
    byPriorityBuckets.get(p).push(days);
  }

  const byPriority = sortPriorities(
    Array.from(byPriorityBuckets.entries()).map(([priority, arr]) => ({
      priority,
      count: arr.length,
      medianDays: round1(median(arr)),
    }))
  );

  let previousMedianDays = null;
  if (jqlPrevious) {
    const prev = await jira.searchAll(jqlPrevious, {
      fields: ["created", "resolutiondate"],
      pageSize: 100,
      hardCap: 500,
    });
    const prevAges = prev
      .map((i) => {
        const c = i.fields?.created;
        const r = i.fields?.resolutiondate;
        if (!c || !r) return null;
        const d = (Date.parse(r) - Date.parse(c)) / 86_400_000;
        return Number.isFinite(d) && d >= 0 ? d : null;
      })
      .filter((x) => x !== null);
    previousMedianDays = round1(median(prevAges));
  }

  const medianDays = round1(median(agesDays));
  const meanDays =
    agesDays.length > 0
      ? round1(agesDays.reduce((a, b) => a + b, 0) / agesDays.length)
      : 0;
  const p95Days = round1(percentile(agesDays, 95));

  const deltaDays =
    previousMedianDays !== null ? round1(medianDays - previousMedianDays) : null;

  return {
    lookbackDays,
    sampleSize: agesDays.length,
    medianDays,
    meanDays,
    p95Days,
    previousMedianDays,
    deltaDays,
    byPriority,
    generatedAt: Date.now(),
    timezone,
    jql,
  };
}

/**
 * Kanban board snapshot — compact live view of the team's RapidBoard,
 * grouped by status column with a cap on visible cards per column.
 *
 * `jql` should match the board filter in Jira (e.g. the same query that
 * backs rapidView=101032). `columns`, when set, forces the column order
 * (and shows empty columns) so the on-screen board matches Jira exactly.
 */
export async function buildKanbanBoard({
  jira,
  jql,
  columns = null,
  maxPerColumn = 6,
  hardCap = 120,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
  boardUrl = null,
}) {
  if (!jira) throw new Error("buildKanbanBoard: jira client required");
  if (!jql) throw new Error("buildKanbanBoard: jql required");

  const issues = await jira.searchAll(jql, {
    fields: [
      "summary",
      "status",
      "assignee",
      "priority",
      "updated",
      "created",
      "issuetype",
    ],
    pageSize: 50,
    hardCap,
  });

  const seen = new Map();
  const toTicket = (iss) => ({
    key: iss.key,
    summary: iss.fields?.summary ?? "(no summary)",
    assignee: iss.fields?.assignee?.displayName ?? null,
    assigneeKey: iss.fields?.assignee?.key ?? iss.fields?.assignee?.name ?? null,
    priority: iss.fields?.priority?.name ?? null,
    status: iss.fields?.status?.name ?? "Unknown",
    statusCategory:
      iss.fields?.status?.statusCategory?.key ??
      iss.fields?.status?.statusCategory?.name?.toLowerCase() ??
      null,
    issueType: iss.fields?.issuetype?.name ?? null,
    updatedAt: iss.fields?.updated ?? null,
    createdAt: iss.fields?.created ?? null,
  });

  for (const iss of issues) {
    const t = toTicket(iss);
    const bucket = seen.get(t.status) ?? [];
    bucket.push(t);
    seen.set(t.status, bucket);
  }

  // Keep each column's tickets in "recently updated first" order.
  for (const [, arr] of seen) {
    arr.sort((a, b) => {
      const bu = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      const au = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      return bu - au;
    });
  }

  const orderedNames =
    columns && columns.length > 0 ? [...columns] : Array.from(seen.keys());
  // Append any statuses we saw but weren't in the requested order.
  if (columns) {
    for (const name of seen.keys()) {
      if (!orderedNames.includes(name)) orderedNames.push(name);
    }
  }

  const columnData = orderedNames.map((name) => {
    const tickets = seen.get(name) ?? [];
    return {
      name,
      statusCategory: tickets[0]?.statusCategory ?? null,
      total: tickets.length,
      tickets: tickets.slice(0, maxPerColumn),
      truncated: Math.max(0, tickets.length - maxPerColumn),
    };
  });

  return {
    total: issues.length,
    columns: columnData,
    maxPerColumn,
    boardUrl,
    generatedAt: Date.now(),
    timezone,
    jql,
  };
}

/**
 * Inflow vs Resolved — weekly "are we getting ahead or falling behind?"
 *
 * Pulls two counts per week:
 *   created:  tickets that entered the queue
 *   resolved: tickets that left the queue (reached Done / resolved)
 *
 * Reports:
 *   - This week's created / resolved / net (resolved - created)
 *   - Previous week's values + delta
 *   - Last N weeks' trend for each series (for dual-line chart)
 *
 * Expects `jql` to describe the population of tickets this team cares
 * about (e.g. `project = EMAIL AND type in (Task, Bug, Story)`). The
 * builder wraps it with created/resolved range filters.
 */
export async function buildInflowVsResolved({
  jira,
  jql,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
  now = new Date(),
  weeksOfTrend = WEEKS_OF_TREND,
}) {
  if (!jira) throw new Error("buildInflowVsResolved: jira client required");
  if (!jql) throw new Error("buildInflowVsResolved: jql required");

  const thisMonday = mondayOfWeek(now, timezone);
  const lastMonday = addDays(thisMonday, -7);
  const prevMonday = addDays(lastMonday, -7);

  const createdWithin = (from, to) =>
    `(${jql}) AND created >= "${from}" AND created < "${to}"`;
  const resolvedWithin = (from, to) =>
    `(${jql}) AND resolved >= "${from}" AND resolved < "${to}"`;

  // Build week boundaries (N most recent completed weeks, oldest first,
  // ending with the just-finished "last week").
  const weeks = [];
  for (let i = weeksOfTrend - 1; i >= 0; i--) {
    const from = addDays(lastMonday, -7 * i);
    const to = addDays(from, 7);
    weeks.push({ from, to });
  }
  const trendLabels = weeks.map(({ from }) =>
    isoWeekLabel(new Date(`${from.split(" ")[0]}T00:00:00Z`))
  );

  const createdTrendP = weeks.map(({ from, to }) =>
    jira.searchCount(createdWithin(from, to))
  );
  const resolvedTrendP = weeks.map(({ from, to }) =>
    jira.searchCount(resolvedWithin(from, to))
  );
  const [trendCreated, trendResolved] = await Promise.all([
    Promise.all(createdTrendP),
    Promise.all(resolvedTrendP),
  ]);

  const created = trendCreated[trendCreated.length - 1] ?? 0;
  const resolved = trendResolved[trendResolved.length - 1] ?? 0;
  const previousCreated = trendCreated[trendCreated.length - 2] ?? 0;
  const previousResolved = trendResolved[trendResolved.length - 2] ?? 0;

  const net = resolved - created;
  const previousNet = previousResolved - previousCreated;
  const netDeltaAbs = net - previousNet;

  return {
    weekLabel: isoWeekLabel(
      new Date(`${lastMonday.split(" ")[0]}T00:00:00Z`)
    ),
    weekRange: prettyWeekRange(lastMonday, addDays(lastMonday, 6)),
    created,
    resolved,
    net,
    previousCreated,
    previousResolved,
    previousNet,
    netDeltaAbs,
    trendCreated,
    trendResolved,
    trendLabels,
    generatedAt: Date.now(),
    timezone,
    jql,
  };
}

/**
 * Default priority-based SLA thresholds (in days) used when the team
 * hasn't configured their own. Tickets that exceed their threshold are
 * considered "breaching"; within 24h / 48h of breach are "imminent" /
 * "warning". Everything else is "ok".
 *
 * These are intentionally conservative — tune via JIRA_SLA_THRESHOLDS
 * (e.g. `Critical:1,High:3,Medium:7,Low:14`).
 */
// Conservative defaults covering both Gen's P0–P4 scheme (current) and
// legacy Highest/Critical/…/Lowest Jira names, so SLA risk is meaningful
// without any config on day one. Override per-deploy via JIRA_SLA_THRESHOLDS,
// e.g. `P0:1,P1:3,P2:7,P3:30,P4:60`.
export const DEFAULT_SLA_THRESHOLDS_DAYS = {
  P0: 1,
  P1: 3,
  P2: 7,
  P3: 30,
  P4: 60,
  Highest: 1,
  Critical: 1,
  High: 3,
  Medium: 7,
  Low: 14,
  Lowest: 21,
  Unprioritised: 14,
};

export function parseSlaThresholds(raw) {
  if (!raw) return { ...DEFAULT_SLA_THRESHOLDS_DAYS };
  const out = { ...DEFAULT_SLA_THRESHOLDS_DAYS };
  for (const part of String(raw).split(",")) {
    const [k, v] = part.split(":").map((s) => s?.trim());
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/**
 * SLA / Aging Risk — "which open tickets are in danger right now?"
 *
 * For every open ticket in `jql`, compute age-since-created, compare to
 * the priority-based SLA threshold, and bucket:
 *   - breaching:  age >= threshold
 *   - imminent:   threshold - 1d <= age < threshold     (≤24h to breach)
 *   - warning:    threshold - 2d <= age < threshold-1d  (≤48h to breach)
 *   - ok:         everything else
 *
 * Returns bucket totals, the top N at-risk tickets (by priority then age),
 * and the thresholds used so the UI can surface them.
 */
export async function buildSlaAgingRisk({
  jira,
  jql,
  thresholds = DEFAULT_SLA_THRESHOLDS_DAYS,
  topN = 5,
  hardCap = 500,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
}) {
  if (!jira) throw new Error("buildSlaAgingRisk: jira client required");
  if (!jql) throw new Error("buildSlaAgingRisk: jql required");

  const issues = await jira.searchAll(jql, {
    fields: ["summary", "status", "assignee", "priority", "created", "updated"],
    pageSize: 100,
    hardCap,
  });

  const now = Date.now();
  const buckets = { breaching: 0, imminent: 0, warning: 0, ok: 0 };
  const byPriorityCounts = new Map();
  const risks = [];

  for (const iss of issues) {
    const created = iss.fields?.created;
    if (!created) continue;
    const ageDays = (now - Date.parse(created)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0) continue;

    const priority = iss.fields?.priority?.name ?? "Unprioritised";
    const threshold =
      thresholds[priority] ??
      DEFAULT_SLA_THRESHOLDS_DAYS[priority] ??
      DEFAULT_SLA_THRESHOLDS_DAYS.Unprioritised;

    let bucket;
    if (ageDays >= threshold) bucket = "breaching";
    else if (ageDays >= threshold - 1) bucket = "imminent";
    else if (ageDays >= threshold - 2) bucket = "warning";
    else bucket = "ok";

    buckets[bucket] += 1;

    const pc = byPriorityCounts.get(priority) ?? { priority, count: 0, atRisk: 0 };
    pc.count += 1;
    if (bucket !== "ok") pc.atRisk += 1;
    byPriorityCounts.set(priority, pc);

    if (bucket !== "ok") {
      risks.push({
        key: iss.key,
        summary: iss.fields?.summary ?? "(no summary)",
        assignee: iss.fields?.assignee?.displayName ?? null,
        priority,
        status: iss.fields?.status?.name ?? "Unknown",
        ageDays: round1(ageDays),
        thresholdDays: threshold,
        overdueDays: round1(ageDays - threshold),
        bucket,
      });
    }
  }

  // Rank risks: breaching first, then imminent, then warning; within each,
  // highest priority first, then most overdue first.
  const bucketRank = { breaching: 0, imminent: 1, warning: 2, ok: 3 };
  const prioRank = (p) => {
    const i = PRIORITY_ORDER.indexOf(p);
    return i === -1 ? 999 : i;
  };
  risks.sort((a, b) => {
    if (bucketRank[a.bucket] !== bucketRank[b.bucket]) {
      return bucketRank[a.bucket] - bucketRank[b.bucket];
    }
    if (prioRank(a.priority) !== prioRank(b.priority)) {
      return prioRank(a.priority) - prioRank(b.priority);
    }
    return b.overdueDays - a.overdueDays;
  });

  const byPriority = sortPriorities(
    Array.from(byPriorityCounts.values()).filter((x) => x.count > 0)
  );

  const total = issues.length;
  const atRisk = buckets.breaching + buckets.imminent + buckets.warning;

  return {
    total,
    atRisk,
    buckets,
    byPriority,
    thresholds,
    topRisks: risks.slice(0, topN),
    generatedAt: Date.now(),
    timezone,
    jql,
  };
}

/**
 * Top Priority Tickets — the small set of open tickets that leadership
 * most needs eyes on right now. Unlike SLA / Aging Risk (time-based),
 * this is strictly importance-based: highest priority first, most
 * recently updated within priority.
 *
 * Expects `jql` to describe "all open tickets" — the builder adds the
 * priority filter on top. `priorities` is the allow-list (defaults to
 * Highest / Critical / High so we only surface the stuff that matters).
 */
export async function buildTopPriorityTickets({
  jira,
  jql,
  priorities = ["Highest", "Critical", "High"],
  status = "To Do",
  topN = 6,
  hardCap = 60,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
}) {
  if (!jira) throw new Error("buildTopPriorityTickets: jira client required");
  if (!jql) throw new Error("buildTopPriorityTickets: jql required");

  const priList = priorities.map((p) => `"${p}"`).join(", ");
  // `status` accepts either a single name ("To Do") or a comma-separated
  // list ("To Do, In Progress"). We build:
  //   no status   — scope the full base JQL (any open status)
  //   one status  — `status = "X"`
  //   many        — `status in ("X", "Y", ...)`
  // The previous single-string-only shape hid in-flight high-priority
  // work from leadership — feedback was "this widget shows 0 even
  // though Kristýna has 2 Highest tickets in progress right now".
  const statusList = Array.isArray(status)
    ? status
    : typeof status === "string"
      ? status
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  let statusClause = "";
  if (statusList.length === 1) {
    statusClause = ` AND status = "${statusList[0]}"`;
  } else if (statusList.length > 1) {
    const quoted = statusList.map((s) => `"${s}"`).join(", ");
    statusClause = ` AND status in (${quoted})`;
  }
  const scopedJql =
    `(${jql}) AND priority in (${priList})${statusClause}` +
    ` ORDER BY priority DESC, updated DESC`;

  // Cap the server-side fetch tightly — we only ever surface `topN`,
  // so there's no value in pulling the whole queue.
  const capped = Math.max(topN * 2, 20);
  const issues = await jira.searchAll(scopedJql, {
    fields: [
      "summary",
      "status",
      "assignee",
      "priority",
      "created",
      "updated",
      "issuetype",
    ],
    pageSize: capped,
    hardCap: Math.min(hardCap, capped),
  });

  const prioRank = (p) => {
    const i = PRIORITY_ORDER.indexOf(p);
    return i === -1 ? 999 : i;
  };

  const tickets = issues.map((iss) => {
    const created = iss.fields?.created ?? null;
    const updated = iss.fields?.updated ?? null;
    const ageDays = created
      ? Math.max(0, (Date.now() - Date.parse(created)) / 86_400_000)
      : null;
    return {
      key: iss.key,
      summary: iss.fields?.summary ?? "(no summary)",
      assignee: iss.fields?.assignee?.displayName ?? null,
      assigneeKey:
        iss.fields?.assignee?.key ?? iss.fields?.assignee?.name ?? null,
      priority: iss.fields?.priority?.name ?? "Unprioritised",
      status: iss.fields?.status?.name ?? "Unknown",
      statusCategory:
        iss.fields?.status?.statusCategory?.key ??
        iss.fields?.status?.statusCategory?.name?.toLowerCase() ??
        null,
      issueType: iss.fields?.issuetype?.name ?? null,
      createdAt: created,
      updatedAt: updated,
      ageDays: ageDays === null ? null : round1(ageDays),
    };
  });

  tickets.sort((a, b) => {
    if (prioRank(a.priority) !== prioRank(b.priority)) {
      return prioRank(a.priority) - prioRank(b.priority);
    }
    const au = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bu = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bu - au;
  });

  const byPriorityMap = new Map();
  for (const t of tickets) {
    byPriorityMap.set(t.priority, (byPriorityMap.get(t.priority) ?? 0) + 1);
  }
  const byPriority = sortPriorities(
    Array.from(byPriorityMap.entries()).map(([priority, count]) => ({
      priority,
      count,
    }))
  );

  return {
    total: tickets.length,
    priorities,
    status,
    topN,
    byPriority,
    tickets: tickets.slice(0, topN),
    truncated: Math.max(0, tickets.length - topN),
    generatedAt: Date.now(),
    timezone,
    jql: scopedJql,
  };
}

/**
 * CSM Sprint Backlog — snapshot of the team's planning-view backlog
 * (the "To Do" column of the RapidBoard). Designed to answer "how much
 * work is queued up and what's the shape of it?" at a glance.
 *
 * Aggregates only — no per-ticket rows, so it stays cheap even on
 * a large board.
 */
export async function buildSprintBacklog({
  jira,
  jql,
  status = "To Do",
  topAssignees = 4,
  hardCap = 200,
  boardUrl = null,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
}) {
  if (!jira) throw new Error("buildSprintBacklog: jira client required");
  if (!jql) throw new Error("buildSprintBacklog: jql required");

  const scopedJql = status ? `(${jql}) AND status = "${status}"` : `(${jql})`;
  const issues = await jira.searchAll(scopedJql, {
    fields: ["summary", "priority", "assignee", "created", "updated"],
    pageSize: 100,
    hardCap,
  });

  const total = issues.length;

  const byPriorityMap = new Map();
  const byAssigneeMap = new Map();
  let unassigned = 0;
  const now = Date.now();
  const ageDays = [];

  for (const iss of issues) {
    const p = iss.fields?.priority?.name ?? "Unprioritised";
    byPriorityMap.set(p, (byPriorityMap.get(p) ?? 0) + 1);

    const aName = iss.fields?.assignee?.displayName ?? null;
    if (aName) {
      byAssigneeMap.set(aName, (byAssigneeMap.get(aName) ?? 0) + 1);
    } else {
      unassigned += 1;
    }

    const created = iss.fields?.created;
    if (created) {
      const d = (now - Date.parse(created)) / 86_400_000;
      if (Number.isFinite(d) && d >= 0) ageDays.push(d);
    }
  }

  const byPriority = sortPriorities(
    Array.from(byPriorityMap.entries()).map(([priority, count]) => ({
      priority,
      count,
    }))
  );

  const byAssignee = Array.from(byAssigneeMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topAssignees);

  return {
    total,
    status,
    byPriority,
    byAssignee,
    unassigned,
    medianAgeDays: round1(median(ageDays)),
    oldestAgeDays: ageDays.length > 0 ? round1(Math.max(...ageDays)) : 0,
    boardUrl,
    generatedAt: Date.now(),
    timezone,
    jql: scopedJql,
  };
}

/**
 * Reopen / Escalation Rate — quality signal measuring what share of
 * tickets that reached Done in a window were kicked back out.
 *
 * Uses Jira's `status changed` operator so the metric holds even when
 * a ticket has been reopened and re-closed multiple times. Both
 * queries are unique-issue counts — an issue that bounced Done → Open
 * → Done → Open during the window still only counts once in each
 * bucket, which is what leadership intuitively wants.
 *
 * Rate = reopenedInWindow / resolvedInWindow  (capped at 0..1)
 */
export async function buildReopenRate({
  jira,
  jql,
  doneStatuses = ["Done", "Closed", "Resolved"],
  windowDays = 30,
  topN = 3,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
}) {
  if (!jira) throw new Error("buildReopenRate: jira client required");
  if (!jql) throw new Error("buildReopenRate: jql required");

  const doneList = doneStatuses.map((s) => `"${s}"`).join(", ");
  const fromRel = `-${Math.max(1, Math.round(windowDays))}d`;

  // Total issues that reached "done" in the window.
  const resolvedJql =
    `(${jql}) AND status changed TO (${doneList}) AFTER "${fromRel}"`;
  // Of those (or overlapping in the window), issues that also left the
  // done state — i.e. were reopened or re-escalated.
  const reopenedJql =
    `(${jql}) AND status changed TO (${doneList}) AFTER "${fromRel}"` +
    ` AND status changed FROM (${doneList}) AFTER "${fromRel}"`;
  // Detail list: tickets currently NOT done that were done in the
  // window — these are the clearest "came back" examples for the UI.
  const topReopenedJql =
    `(${jql}) AND status changed FROM (${doneList}) AFTER "${fromRel}"` +
    ` AND statusCategory != Done` +
    ` ORDER BY updated DESC`;

  const [resolvedInWindow, reopenedInWindow, topIssues] = await Promise.all([
    jira.searchCount(resolvedJql),
    jira.searchCount(reopenedJql),
    jira
      .search(topReopenedJql, {
        fields: ["summary", "status", "assignee", "priority", "updated"],
        maxResults: topN,
      })
      .then((r) => r.issues ?? []),
  ]);

  const safeResolved = Math.max(0, resolvedInWindow);
  const safeReopened = Math.max(0, Math.min(reopenedInWindow, safeResolved));
  const cleanClosed = Math.max(0, safeResolved - safeReopened);
  const rate =
    safeResolved > 0 ? (safeReopened / safeResolved) * 100 : 0;

  const topReopened = topIssues.map((iss) => ({
    key: iss.key,
    summary: iss.fields?.summary ?? "(no summary)",
    assignee: iss.fields?.assignee?.displayName ?? null,
    priority: iss.fields?.priority?.name ?? "Unprioritised",
    status: iss.fields?.status?.name ?? "Unknown",
    statusCategory:
      iss.fields?.status?.statusCategory?.key ??
      iss.fields?.status?.statusCategory?.name?.toLowerCase() ??
      null,
    updatedAt: iss.fields?.updated ?? null,
  }));

  return {
    windowDays,
    resolvedInWindow: safeResolved,
    reopenedInWindow: safeReopened,
    cleanClosed,
    rate: round1(rate),
    doneStatuses,
    topReopened,
    generatedAt: Date.now(),
    timezone,
    jql: resolvedJql,
  };
}

/**
 * Team Throughput Leaderboard — who resolved the most tickets in the
 * window, with a per-person weekly trend sparkline.
 *
 * Data model intentionally mirrors the Weekly Throughput widget so the
 * two sit next to each other naturally:
 *   - weekly totals over the last `weeksOfTrend` completed weeks
 *     (oldest → newest), which client-side turns into a sparkline
 *   - last-week total, previous-week total, and a delta
 *   - sorted by last-week total desc
 *
 * One Jira search call over the whole window; all bucketing happens
 * in-process so we don't hammer Jira once per person.
 */
export async function buildThroughputLeaderboard({
  jira,
  jql,
  timezone = process.env.TEAM_TIMEZONE ?? "Europe/Prague",
  now = new Date(),
  weeksOfTrend = WEEKS_OF_TREND,
  topN = 6,
  hardCap = 2000,
}) {
  if (!jira) throw new Error("buildThroughputLeaderboard: jira client required");
  if (!jql) throw new Error("buildThroughputLeaderboard: jql required");

  // Week boundaries — same arithmetic as buildWeeklyThroughput so the
  // "last week" totals on both widgets agree.
  const thisMonday = mondayOfWeek(now, timezone);
  const lastMonday = addDays(thisMonday, -7);
  const windowStart = addDays(lastMonday, -7 * (weeksOfTrend - 1));
  const lastSunday23 = addDays(lastMonday, 7);

  const searchJql =
    `(${jql}) AND resolved >= "${windowStart}"` +
    ` AND resolved < "${lastSunday23}"`;

  const issues = await jira.searchAll(searchJql, {
    fields: ["assignee", "resolutiondate"],
    pageSize: 100,
    hardCap,
  });

  // Build the ordered list of week-start timestamps (oldest first)
  // and a lookup from "YYYY-MM-DD" (Monday) to index.
  const weekStarts = [];
  const weekLabels = [];
  const weekIndexByDate = new Map();
  for (let i = 0; i < weeksOfTrend; i++) {
    const from = addDays(windowStart, 7 * i);
    weekStarts.push(from);
    weekLabels.push(
      isoWeekLabel(new Date(`${from.split(" ")[0]}T00:00:00Z`))
    );
    weekIndexByDate.set(from.split(" ")[0], i);
  }

  // Index each ticket into (assignee, week bucket).
  const byPerson = new Map();
  const ensurePerson = (key, display, avatar) => {
    if (!byPerson.has(key)) {
      byPerson.set(key, {
        key,
        name: display,
        avatarUrl: avatar ?? null,
        weekly: new Array(weeksOfTrend).fill(0),
        total: 0,
      });
    }
    return byPerson.get(key);
  };

  for (const iss of issues) {
    const assignee = iss.fields?.assignee;
    const resolved = iss.fields?.resolutiondate;
    if (!resolved) continue;

    // Find which week bucket this resolution falls into. We walk the
    // week starts instead of computing an ISO week directly — avoids
    // off-by-one noise at the Mon boundary in the team timezone.
    const resolvedMs = Date.parse(resolved);
    if (!Number.isFinite(resolvedMs)) continue;
    let bucket = -1;
    for (let i = 0; i < weekStarts.length; i++) {
      const fromMs = Date.parse(
        `${weekStarts[i].split(" ")[0]}T00:00:00Z`
      );
      const nextStart =
        i + 1 < weekStarts.length
          ? Date.parse(`${weekStarts[i + 1].split(" ")[0]}T00:00:00Z`)
          : Date.parse(`${lastSunday23.split(" ")[0]}T00:00:00Z`);
      if (resolvedMs >= fromMs && resolvedMs < nextStart) {
        bucket = i;
        break;
      }
    }
    if (bucket < 0) continue;

    const key =
      assignee?.key ?? assignee?.name ?? assignee?.accountId ?? "__unassigned";
    const display = assignee?.displayName ?? "Unassigned";
    const avatar =
      assignee?.avatarUrls?.["48x48"] ??
      assignee?.avatarUrls?.["32x32"] ??
      null;
    const person = ensurePerson(key, display, avatar);
    person.weekly[bucket] += 1;
    person.total += 1;
  }

  const lastIdx = weeksOfTrend - 1;
  const prevIdx = weeksOfTrend - 2;

  const rows = Array.from(byPerson.values())
    .map((p) => {
      const lastWeek = p.weekly[lastIdx] ?? 0;
      const prevWeek = p.weekly[prevIdx] ?? 0;
      return {
        ...p,
        lastWeek,
        prevWeek,
        deltaAbs: lastWeek - prevWeek,
      };
    })
    .filter((p) => p.total > 0)
    .sort(
      (a, b) =>
        b.lastWeek - a.lastWeek ||
        b.total - a.total ||
        a.name.localeCompare(b.name)
    );

  const topRows = rows.slice(0, topN);
  const totalResolvedWindow = rows.reduce((a, r) => a + r.total, 0);
  const totalLastWeek = rows.reduce((a, r) => a + r.lastWeek, 0);

  return {
    weekLabel: isoWeekLabel(
      new Date(`${lastMonday.split(" ")[0]}T00:00:00Z`)
    ),
    weekRange: prettyWeekRange(lastMonday, addDays(lastMonday, 6)),
    weeksOfTrend,
    weekLabels,
    topN,
    rows: topRows,
    truncated: Math.max(0, rows.length - topN),
    contributorsCount: rows.length,
    totalLastWeek,
    totalResolvedWindow,
    generatedAt: Date.now(),
    timezone,
    jql: searchJql,
  };
}

/** Slack-friendly mrkdwn + a quickchart.io sparkline image for the Monday post. */
export function formatThroughputForSlack(payload, { dashboardUrl } = {}) {
  const arrow =
    payload.deltaAbs > 0 ? ":arrow_up_small:" : payload.deltaAbs < 0 ? ":arrow_down_small:" : ":small_blue_diamond:";
  const sign = payload.deltaAbs > 0 ? "+" : "";
  const deltaLine = `${arrow} ${sign}${payload.deltaAbs} (${sign}${payload.deltaPct}%) vs previous week`;

  const chartCfg = {
    type: "line",
    data: {
      labels: payload.trendLabels,
      datasets: [
        {
          data: payload.trend,
          borderColor: "#4A154B",
          backgroundColor: "rgba(74,21,75,0.15)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { beginAtZero: true },
      },
    },
  };
  const imageUrl = `https://quickchart.io/chart?w=600&h=220&c=${encodeURIComponent(
    JSON.stringify(chartCfg)
  )}`;

  return {
    text: `Weekly throughput — ${payload.weekRange}: *${payload.resolved}* resolved (${deltaLine})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:bar_chart: *Weekly throughput — ${payload.weekRange}*\n` +
            `*${payload.resolved}* issues resolved  ${deltaLine}` +
            (dashboardUrl ? `\n<${dashboardUrl}|Open live dashboard>` : ""),
        },
      },
      {
        type: "image",
        image_url: imageUrl,
        alt_text: `Weekly throughput trend, last ${payload.trend.length} weeks`,
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Week ${payload.weekLabel} · timezone ${payload.timezone} · auto-generated_`,
          },
        ],
      },
    ],
  };
}
