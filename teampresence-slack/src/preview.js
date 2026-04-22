import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM, rosterMember } from "./team.js";
import { FILTER_BUILDERS } from "./filters.js";

/**
 * Zero-dependency preview of the EMAIL NORTON Team Presence dashboard.
 *
 * Serves the real public/index.html plus a seeded /api/team response,
 * so you can see exactly what the dashboard will look like without
 * installing anything, starting SQLite, or wiring up Slack.
 *
 * Run with:  node src/preview.js
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, "index.html");

const BRAND_NAME = process.env.BRAND_NAME ?? "EMAIL NORTON";
const TEAM_TIMEZONE = process.env.TEAM_TIMEZONE ?? "Europe/Prague";
const PORT = Number(process.env.PORT ?? 3000);

function todayInTz(tz = TEAM_TIMEZONE, when = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(when);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

const now = Date.now();
const minsAgo = (n) => now - n * 60 * 1000;
const hoursAhead = (n) => now + n * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Demo filter config.
 *
 * Preview mode serves static mock data, but we still want the Filter
 * drawer to look identical to the real thing so UX can be iterated
 * offline. These JQLs + env-var names mirror the defaults in web.js.
 * ------------------------------------------------------------------ */
const DEMO_JQL = {
  throughput:
    'project = EMAIL AND issuetype in (Task, Story, Bug) AND statusCategory = Done',
  backlog:
    'project = EMAIL AND statusCategory != Done',
  lifecycle:
    'project = EMAIL AND statusCategory = Done AND resolved >= -30d',
  kanban:
    'project = EMAIL AND statusCategory != Done AND Sprint in openSprints()',
  topPriority:
    'project = EMAIL AND statusCategory != Done AND priority in (Highest, Critical, High)',
  sprintBacklog:
    'project = EMAIL AND Sprint in openSprints() AND status = "To Do"',
  reopen:
    'project = EMAIL AND issuetype in (Task, Story, Bug)',
  leaderboard:
    'project = EMAIL AND issuetype in (Task, Story, Bug) AND statusCategory = Done',
};

const DEMO_BOARD_URL =
  "https://gendigital.atlassian.net/jira/software/c/projects/EMAIL/boards/42";

const DEMO_FILTER_INPUTS = {
  "weekly-throughput": {
    jql: DEMO_JQL.throughput,
    source: "JIRA_THROUGHPUT_JQL",
    refreshSeconds: 15 * 60,
    timezone: TEAM_TIMEZONE,
  },
  "backlog-overview": {
    jql: DEMO_JQL.backlog,
    source: "JIRA_BACKLOG_JQL",
    refreshSeconds: 15 * 60,
    timezone: TEAM_TIMEZONE,
  },
  "ticket-lifecycle": {
    jql: DEMO_JQL.lifecycle,
    source: "JIRA_LIFECYCLE_JQL",
    refreshSeconds: 30 * 60,
    lookbackDays: 30,
    timezone: TEAM_TIMEZONE,
  },
  "inflow-vs-resolved": {
    jql: DEMO_JQL.throughput,
    source: "JIRA_THROUGHPUT_JQL",
    fallbackFrom: "JIRA_INFLOW_JQL",
    refreshSeconds: 15 * 60,
    timezone: TEAM_TIMEZONE,
  },
  "sla-aging-risk": {
    jql: DEMO_JQL.backlog,
    source: "JIRA_BACKLOG_JQL",
    fallbackFrom: "JIRA_SLA_JQL",
    refreshSeconds: 5 * 60,
    thresholds: { Highest: 1, Critical: 2, High: 5, Medium: 14, Low: 30 },
    timezone: TEAM_TIMEZONE,
  },
  "kanban-board": {
    jql: DEMO_JQL.kanban,
    source: "JIRA_KANBAN_JQL",
    refreshSeconds: 3 * 60,
    columns: ["To Do", "In Progress", "In Review", "Done"],
    boardUrl: DEMO_BOARD_URL,
    timezone: TEAM_TIMEZONE,
  },
  "top-priority-tickets": {
    jql: DEMO_JQL.topPriority,
    source: "JIRA_TOP_PRIORITY_JQL",
    refreshSeconds: 5 * 60,
    priorities: ["Highest", "Critical", "High"],
    status: "To Do",
    limit: 6,
    timezone: TEAM_TIMEZONE,
  },
  "sprint-backlog": {
    jql: DEMO_JQL.sprintBacklog,
    source: "JIRA_SPRINT_BACKLOG_JQL",
    refreshSeconds: 5 * 60,
    status: "To Do",
    boardUrl: DEMO_BOARD_URL,
    timezone: TEAM_TIMEZONE,
  },
  "reopen-rate": {
    jql: DEMO_JQL.reopen,
    source: "JIRA_THROUGHPUT_JQL",
    fallbackFrom: "JIRA_REOPEN_JQL",
    refreshSeconds: 15 * 60,
    doneStatuses: ["Done", "Closed", "Resolved"],
    windowDays: 30,
    timezone: TEAM_TIMEZONE,
  },
  "throughput-leaderboard": {
    jql: DEMO_JQL.leaderboard,
    source: "JIRA_THROUGHPUT_JQL",
    fallbackFrom: "JIRA_LEADERBOARD_JQL",
    refreshSeconds: 15 * 60,
    limit: 6,
    timezone: TEAM_TIMEZONE,
  },
};

/**
 * Attach filter metadata to a demo widget payload so the filter drawer
 * has real-looking content in preview mode (matches the prod shape).
 *
 * The `project` arg (EMOPS / EMAILCO / all) tweaks the filter in two
 * ways so the drawer reflects the switcher state:
 *   1. The `source` env-var name is rescoped, e.g.
 *      JIRA_BACKLOG_JQL → JIRA_EMOPS_BACKLOG_JQL
 *      so the operator can see which line in .env is conceptually
 *      driving this demo widget.
 *   2. The `project` field on the filter object is set so the chip
 *      summary reads "EMOPS · snapshot · open" rather than just
 *      "snapshot · open".
 *
 * For `all`, a combined JQL is synthesised (if the original JQL
 * mentioned a specific project) so the drawer JQL pre shows the
 * realistic "project in (EMOPS, EMAILCO)" shape.
 */
function rescopeSource(src, project) {
  if (!src || !src.startsWith("JIRA_")) return src;
  if (!project) return src;
  if (project === "all") return src.replace(/^JIRA_/, "JIRA_ALL_");
  return src.replace(/^JIRA_/, `JIRA_${project.toUpperCase()}_`);
}

function rescopeJql(jql, project) {
  if (!jql || !project) return jql;
  if (project === "all") {
    return jql.replace(
      /project\s*=\s*"?[A-Z][A-Z0-9_-]*"?/i,
      "project in (EMOPS, EMAILCO)"
    );
  }
  return jql.replace(
    /project\s*=\s*"?[A-Z][A-Z0-9_-]*"?/i,
    `project = ${project.toUpperCase()}`
  );
}

function withDemoFilter(id, payload, { project } = {}) {
  const builder = FILTER_BUILDERS[id];
  const input = DEMO_FILTER_INPUTS[id];
  if (!builder || !input) return payload;
  try {
    const scopedJql = rescopeJql(input.jql, project);
    const filter = builder({
      ...input,
      jql: scopedJql,
      source: rescopeSource(input.source, project),
      fallbackFrom: rescopeSource(input.fallbackFrom, project),
      generatedAt: payload?.generatedAt ?? Date.now(),
      project,
    });
    return {
      ...payload,
      project: project ?? null,
      jqlSource: filter?.source ?? null,
      filter,
    };
  } catch (err) {
    console.warn(`[preview] filter meta failed for ${id}:`, err?.message);
    return payload;
  }
}

/**
 * Parse ?project= from the raw URL, normalise, and validate against
 * the demo project list. Unknown or missing → returns the default
 * (EMOPS) so the demo always produces sensible output.
 */
const DEMO_PROJECTS = [
  { key: "EMOPS", label: "EMOPS (current)", isDefault: true },
  { key: "EMAILCO", label: "EMAILCO (legacy)", isDefault: false },
  { key: "all", label: "Both", isDefault: false },
];
function parseProjectParam(reqUrl) {
  try {
    const url = new URL(reqUrl, "http://localhost");
    const raw = (url.searchParams.get("project") ?? "").trim();
    if (!raw) return "EMOPS";
    const norm = raw.toLowerCase() === "all" ? "all" : raw.toUpperCase();
    if (!DEMO_PROJECTS.some((p) => p.key === norm)) return "EMOPS";
    return norm;
  } catch {
    return "EMOPS";
  }
}

/**
 * Build a demo /api/team payload that mirrors the production
 * PRESENCE_MODEL=slack+workday shape. Every member carries a
 * plausible Slack status + bucket so the new UI source chip, status
 * line, and Workday vacation overlay are all exercised offline.
 *
 * Each seed below spells out the raw Slack profile it would have
 * come from — status_emoji, status_text, auto-presence — plus the
 * bucket+reason the classifier would have produced. Keeping both
 * gives the demo the same "trace the data back to its source"
 * accuracy that CSM teams asked for.
 */
function buildDemoPayload() {
  const date = todayInTz();

  const seeds = {
    "iryna-botulinska": {
      id: "U001",
      slackStatus: {
        bucket: "available",
        reason: "Slack auto-presence = active",
        line: null,
        emoji: "",
        text: "",
        expiration: 0,
        autoPresence: "active",
        source: "slack",
      },
      workday: null,
    },
    "victor-shapochkin": {
      id: "U002",
      slackStatus: {
        bucket: "wfh",
        reason: 'text match "focus"',
        line: "🏠 WFH — Focus day on Q2 launch",
        emoji: ":house:",
        text: "WFH — Focus day on Q2 launch",
        expiration: 0,
        autoPresence: "active",
        source: "slack",
      },
      workday: null,
    },
    "petr-studeny": {
      id: "U003",
      slackStatus: {
        bucket: "away",
        reason: 'text match "train"',
        line: "🚆 Running late — train delay",
        emoji: ":train:",
        text: "Running late — train delay",
        expiration: Math.floor(hoursAhead(1) / 1000),
        autoPresence: "away",
        source: "slack",
      },
      workday: null,
    },
    "jan-bartoncik": {
      id: "U004",
      slackStatus: {
        bucket: "vacation",
        reason: "emoji :face_with_thermometer: (sick/family)",
        line: "🤒 Out sick",
        emoji: ":face_with_thermometer:",
        text: "Out sick",
        expiration: 0,
        autoPresence: "away",
        source: "slack",
      },
      workday: null,
    },
    "kristyna-simkova": {
      // Workday overrides Slack: even though the card also shows
      // her Slack status (🏖️ Ibiza), the bucket is forced to
      // vacation by the Workday PTO entry. This is the exact
      // priority rule resolvePresence() enforces in production.
      id: "U005",
      slackStatus: {
        bucket: "vacation",
        reason: "Workday PTO through 2026-04-25",
        line: "🏖️ Ibiza — back Monday",
        emoji: ":beach_with_umbrella:",
        text: "Ibiza — back Monday",
        expiration: 0,
        autoPresence: "away",
        source: "workday",
      },
      workday: { type: "PTO", through: "2026-04-25" },
    },
    "daniel-zabensky": {
      id: "U006",
      slackStatus: {
        bucket: "meeting",
        reason: "emoji :spiral_calendar_pad:",
        line: "📅 Campaign review — 30m",
        emoji: ":spiral_calendar_pad:",
        text: "Campaign review — 30m",
        expiration: Math.floor(hoursAhead(0.5) / 1000),
        autoPresence: "active",
        source: "slack",
      },
      workday: null,
    },
    "yanina-scholz": {
      id: "U007",
      slackStatus: {
        bucket: "unknown",
        reason: "no status or presence",
        line: null,
        emoji: "",
        text: "",
        expiration: 0,
        autoPresence: null,
        source: "slack",
      },
      workday: null,
    },
    "volodymyr-yatsenko": {
      id: "U008",
      slackStatus: {
        bucket: "wfh",
        reason: "emoji :house_with_garden:",
        line: "🏡 WFH — CS escalations queue",
        emoji: ":house_with_garden:",
        text: "WFH — CS escalations queue",
        expiration: 0,
        autoPresence: "active",
        source: "slack",
      },
      workday: null,
    },
  };

  const members = TEAM
    .map((m) => rosterMember(m.slug, seeds[m.slug] ?? { id: m.slug }))
    .filter(Boolean);

  // preview.js intentionally emits NO rollcalls — in the new model
  // (slack+workday) rollcalls are a bot-mode concept and the UI
  // hides the section when the list is empty. Production web.js
  // follows the same convention.
  return {
    brandName: BRAND_NAME,
    date,
    timezone: TEAM_TIMEZONE,
    generatedAt: Date.now(),
    model: "slack+workday",
    models: { bot: false, slack: true, workday: true },
    members,
    rollcalls: [],
    preview: true,
  };
}

/**
 * Demo /api/absences payload. Mirrors the production response shape
 * exactly, so the UI strips ("Out today" + "Out next 7 days") render
 * with the same code path in preview and prod.
 *
 * The dates below are keyed off the server's current date so the
 * demo stays evergreen — we don't hardcode "2026-04-20" and have it
 * go stale next week.
 */
function buildDemoAbsences({ days = 7 } = {}) {
  const today = new Date();
  const ymd = (offsetDays) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const rosterBySlug = new Map(TEAM.map((m) => [m.slug, m]));
  const asRow = (slug, startOff, endOff, type, note) => {
    const member = rosterBySlug.get(slug);
    if (!member) return null;
    return {
      slackId: null,
      email: null,
      slug,
      startDate: ymd(startOff),
      endDate: ymd(endOff),
      type,
      note,
      member: {
        name: member.displayName || member.fullName,
        fullName: member.fullName,
        avatarUrl: member.avatarUrl,
        role: member.role,
        team: member.team,
        slug: member.slug,
      },
    };
  };

  const all = [
    // Out TODAY — drives the hero strip.
    asRow("kristyna-simkova", -2, 3, "PTO", "Ibiza — back Monday"),
    asRow("jan-bartoncik", 0, 0, "Sick", "Flu"),
    // Out NEXT 7 DAYS — drives the carousel.
    asRow("petr-studeny", 5, 6, "Personal", "Doctor appointment"),
    asRow("yanina-scholz", 6, 10, "PTO", "Family wedding"),
    // Further-out — included in the drawer list but not the carousel.
    asRow("daniel-zabensky", 21, 25, "PTO", "Prague spring break"),
    asRow("victor-shapochkin", 28, 32, "PTO", "Back-to-back conferences"),
  ].filter(Boolean);

  const todayYmd = ymd(0);
  const cutoff = ymd(days);
  const inTheNext = all.filter(
    (a) => a.endDate >= todayYmd && a.startDate <= cutoff
  );
  const todays = inTheNext.filter(
    (a) => todayYmd >= a.startDate && todayYmd <= a.endDate
  );
  const upcoming = inTheNext.filter((a) => a.startDate > todayYmd);

  return {
    generatedAt: Date.now(),
    model: "slack+workday",
    source: "csv",
    windowDays: days,
    today: todays,
    upcoming,
    totals: { today: todays.length, upcoming: upcoming.length },
    preview: true,
  };
}

function buildDemoBacklog() {
  return {
    total: 87,
    previous: 84,
    deltaAbs: 3,
    deltaPct: 3.6,
    byPriority: [
      { priority: "Critical", count: 4 },
      { priority: "High", count: 18 },
      { priority: "Medium", count: 41 },
      { priority: "Low", count: 24 },
    ],
    byAge: { new: 12, recent: 31, aging: 28, stale: 16 },
    newThisWeek: 14,
    resolvedThisWeek: 11,
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql: "project = EMAIL AND statusCategory != Done",
    preview: true,
  };
}

function buildDemoLifecycle() {
  return {
    lookbackDays: 30,
    sampleSize: 124,
    medianDays: 4.2,
    meanDays: 6.1,
    p95Days: 22.4,
    previousMedianDays: 5.0,
    deltaDays: -0.8,
    byPriority: [
      { priority: "Critical", count: 5, medianDays: 1.2 },
      { priority: "High", count: 28, medianDays: 3.4 },
      { priority: "Medium", count: 61, medianDays: 5.1 },
      { priority: "Low", count: 30, medianDays: 9.8 },
    ],
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql: "project = EMAIL AND statusCategory = Done AND resolved >= -30d",
    preview: true,
  };
}

function buildDemoInflowVsResolved() {
  // 8 completed weeks, oldest first. Mix of "getting ahead" and "falling
  // behind" weeks so the chart looks real, ending with a modest net-positive
  // recovery week (resolved > created by a small margin).
  const trendCreated  = [112, 118, 126, 121, 115, 130, 122, 119];
  const trendResolved = [ 98, 104, 120, 131, 117, 112, 118, 124];
  const created = trendCreated[trendCreated.length - 1];
  const resolved = trendResolved[trendResolved.length - 1];
  const previousCreated = trendCreated[trendCreated.length - 2];
  const previousResolved = trendResolved[trendResolved.length - 2];
  const net = resolved - created;
  const previousNet = previousResolved - previousCreated;
  return {
    weekLabel: "2026-W15",
    weekRange: "7 Apr – 13 Apr",
    created,
    resolved,
    net,
    previousCreated,
    previousResolved,
    previousNet,
    netDeltaAbs: net - previousNet,
    trendCreated,
    trendResolved,
    trendLabels: [
      "2026-W08",
      "2026-W09",
      "2026-W10",
      "2026-W11",
      "2026-W12",
      "2026-W13",
      "2026-W14",
      "2026-W15",
    ],
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql: "project = EMAIL AND type in (Task, Bug, Story)",
    preview: true,
  };
}

function buildDemoSlaAgingRisk() {
  return {
    total: 87,
    atRisk: 16,
    buckets: { breaching: 3, imminent: 5, warning: 8, ok: 71 },
    byPriority: [
      { priority: "Critical", count: 4, atRisk: 3 },
      { priority: "High", count: 18, atRisk: 7 },
      { priority: "Medium", count: 41, atRisk: 5 },
      { priority: "Low", count: 24, atRisk: 1 },
    ],
    thresholds: { Critical: 1, High: 3, Medium: 7, Low: 14 },
    topRisks: [
      {
        key: "EMOPS-289",
        summary: "Yahoo postmaster: unblock consumer sending domain",
        assignee: "Petr Studený",
        priority: "Critical",
        status: "In Progress",
        ageDays: 4.2,
        thresholdDays: 1,
        overdueDays: 3.2,
        bucket: "breaching",
      },
      {
        key: "EMOPS-272",
        summary: "Suppression file ingest failing for EU segment",
        assignee: "Iryna Botulinska",
        priority: "Critical",
        status: "To Do",
        ageDays: 2.1,
        thresholdDays: 1,
        overdueDays: 1.1,
        bucket: "breaching",
      },
      {
        key: "EMOPS-268",
        summary: "Renewal journey — segmentation join error on cohort builder",
        assignee: "Victor Shapochkin",
        priority: "High",
        status: "In Progress",
        ageDays: 3.4,
        thresholdDays: 3,
        overdueDays: 0.4,
        bucket: "breaching",
      },
      {
        key: "EMOPS-275",
        summary: "Legal sign-off blocking April trust digest send",
        assignee: "Jan Bartončík",
        priority: "High",
        status: "In Review",
        ageDays: 2.3,
        thresholdDays: 3,
        overdueDays: -0.7,
        bucket: "imminent",
      },
      {
        key: "EMOPS-281",
        summary: "Braze template variant — Outlook dark-mode regression",
        assignee: "Daniel Žabenský",
        priority: "High",
        status: "In Progress",
        ageDays: 1.6,
        thresholdDays: 3,
        overdueDays: -1.4,
        bucket: "warning",
      },
    ],
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql: "project = EMAIL AND statusCategory != Done",
    preview: true,
  };
}

function buildDemoTopPriorityTickets() {
  const hoursAgo = (n) => new Date(now - n * 3600 * 1000).toISOString();
  const daysAgo = (n) => new Date(now - n * 86400 * 1000).toISOString();
  const r1 = (x) => Math.round(x * 10) / 10;

  // Scoped to the "To Do" column of board 101032 — the team's
  // next-up queue rather than the entire open backlog.
  const rawTickets = [
    {
      key: "EMOPS-311",
      summary: "Q2 launch — hero banner copy variants (EN-US / EN-GB)",
      assignee: "Iryna Botulinska",
      assigneeKey: "iryna.botulinska",
      priority: "Critical",
      status: "To Do",
      statusCategory: "new",
      issueType: "Task",
      createdAt: daysAgo(1.3),
      updatedAt: hoursAgo(2),
    },
    {
      key: "EMOPS-289",
      summary: "Yahoo postmaster: unblock consumer sending domain",
      assignee: "Iryna Botulinska",
      assigneeKey: "iryna.botulinska",
      priority: "Critical",
      status: "To Do",
      statusCategory: "new",
      issueType: "Incident",
      createdAt: daysAgo(4.2),
      updatedAt: hoursAgo(5),
    },
    {
      key: "EMOPS-307",
      summary: "Legal review for renewal reminder footer",
      assignee: "Jan Bartončík",
      assigneeKey: "jan.bartoncik",
      priority: "High",
      status: "To Do",
      statusCategory: "new",
      issueType: "Story",
      createdAt: daysAgo(2.1),
      updatedAt: hoursAgo(7),
    },
    {
      key: "EMOPS-304",
      summary: "Darkmode-safe logo lockup for Outlook rendering",
      assignee: "Victor Shapochkin",
      assigneeKey: "victor.shapochkin",
      priority: "High",
      status: "To Do",
      statusCategory: "new",
      issueType: "Task",
      createdAt: daysAgo(1.9),
      updatedAt: daysAgo(1),
    },
    {
      key: "EMOPS-309",
      summary: "Segment win-back cohort for inactive 90+ day subs",
      assignee: "Kristýna Šimková",
      assigneeKey: "kristyna.simkova",
      priority: "High",
      status: "To Do",
      statusCategory: "new",
      issueType: "Task",
      createdAt: daysAgo(2.4),
      updatedAt: hoursAgo(5),
    },
    {
      key: "EMOPS-302",
      summary: "Suppression list cleanup — bounce threshold rules",
      assignee: "Kristýna Šimková",
      assigneeKey: "kristyna.simkova",
      priority: "High",
      status: "To Do",
      statusCategory: "new",
      issueType: "Task",
      createdAt: daysAgo(3.6),
      updatedAt: daysAgo(2),
    },
  ];

  const tickets = rawTickets.map((t) => ({
    ...t,
    ageDays: t.createdAt
      ? r1((now - Date.parse(t.createdAt)) / 86400000)
      : null,
  }));

  return {
    total: 9,
    priorities: ["Highest", "Critical", "High"],
    status: "To Do",
    topN: 6,
    byPriority: [
      { priority: "Critical", count: 2 },
      { priority: "High", count: 7 },
    ],
    tickets,
    truncated: 3,
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql:
      "(project = EMAIL AND filter = 'Norton Email Kanban') AND " +
      "priority in (\"Highest\", \"Critical\", \"High\") AND status = \"To Do\"",
    preview: true,
  };
}

function buildDemoSprintBacklog() {
  return {
    total: 28,
    status: "To Do",
    byPriority: [
      { priority: "Critical", count: 2 },
      { priority: "High", count: 7 },
      { priority: "Medium", count: 13 },
      { priority: "Low", count: 6 },
    ],
    byAssignee: [
      { name: "Iryna Botulinska", count: 6 },
      { name: "Victor Shapochkin", count: 5 },
      { name: "Kristýna Šimková", count: 4 },
      { name: "Daniel Žabenský", count: 3 },
    ],
    unassigned: 4,
    medianAgeDays: 2.4,
    oldestAgeDays: 11.2,
    boardUrl:
      "https://jira.corp.nortonlifelock.com/secure/RapidBoard.jspa?rapidView=101032&view=planning.nodetail&issueLimit=100",
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql:
      "(project = EMAIL AND filter = 'Norton Email Kanban') AND " +
      "status = \"To Do\"",
    preview: true,
  };
}

function buildDemoThroughputLeaderboard() {
  // Weekly resolved counts per person over the last 8 ISO weeks
  // (oldest → newest). Sparklines are drawn client-side from these.
  // Ordering is by last-week resolved desc, so the visual hierarchy
  // matches the medal layout (gold / silver / bronze at the top).
  const rows = [
    {
      key: "iryna.botulinska",
      name: "Iryna Botulinska",
      avatarUrl: "/team/iryna-botulinska.png",
      weekly: [22, 24, 19, 25, 27, 23, 28, 31],
    },
    {
      key: "victor.shapochkin",
      name: "Victor Shapochkin",
      avatarUrl: "/team/victor-shapochkin.png",
      weekly: [18, 17, 20, 23, 19, 22, 26, 27],
    },
    {
      key: "petr.studeny",
      name: "Petr Studený",
      avatarUrl: "/team/petr-studeny.png",
      weekly: [14, 16, 13, 18, 20, 19, 22, 24],
    },
    {
      key: "kristyna.simkova",
      name: "Kristýna Šimková",
      avatarUrl: "/team/kristyna-simkova.png",
      weekly: [11, 12, 15, 14, 13, 16, 17, 19],
    },
    {
      key: "jan.bartoncik",
      name: "Jan Bartončík",
      avatarUrl: "/team/jan-bartoncik.png",
      weekly: [8, 10, 9, 13, 11, 14, 15, 14],
    },
    {
      key: "yanina.scholz",
      name: "Yanina Scholz",
      avatarUrl: "/team/yanina-scholz.png",
      weekly: [6, 7, 5, 9, 8, 10, 11, 9],
    },
  ].map((p) => {
    const total = p.weekly.reduce((a, x) => a + x, 0);
    const lastWeek = p.weekly[p.weekly.length - 1];
    const prevWeek = p.weekly[p.weekly.length - 2];
    return { ...p, total, lastWeek, prevWeek, deltaAbs: lastWeek - prevWeek };
  });

  const totalLastWeek = rows.reduce((a, r) => a + r.lastWeek, 0);
  const totalResolvedWindow = rows.reduce((a, r) => a + r.total, 0);

  return {
    weekLabel: "2026-W15",
    weekRange: "7 Apr – 13 Apr",
    weeksOfTrend: 8,
    weekLabels: [
      "2026-W08", "2026-W09", "2026-W10", "2026-W11",
      "2026-W12", "2026-W13", "2026-W14", "2026-W15",
    ],
    topN: 6,
    rows,
    truncated: 0,
    contributorsCount: rows.length,
    totalLastWeek,
    totalResolvedWindow,
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql:
      "(project = EMAIL AND resolution = Done) AND resolved >= " +
      "\"2026-02-23\" AND resolved < \"2026-04-14\"",
    preview: true,
  };
}

function buildDemoReopenRate() {
  const hoursAgo = (n) => new Date(now - n * 3600 * 1000).toISOString();
  const daysAgo = (n) => new Date(now - n * 86400 * 1000).toISOString();

  const resolved = 124;
  const reopened = 9; // ~7.3% rate — realistic for a healthy team
  return {
    windowDays: 30,
    resolvedInWindow: resolved,
    reopenedInWindow: reopened,
    cleanClosed: resolved - reopened,
    rate: 7.3,
    doneStatuses: ["Done", "Closed", "Resolved"],
    topReopened: [
      {
        key: "EMOPS-268",
        summary: "Renewal journey — segmentation join error on cohort builder",
        assignee: "Victor Shapochkin",
        priority: "High",
        status: "In Progress",
        statusCategory: "indeterminate",
        updatedAt: hoursAgo(6),
      },
      {
        key: "EMOPS-256",
        summary: "Braze template: Outlook dark-mode regression on CTA",
        assignee: "Daniel Žabenský",
        priority: "High",
        status: "To Do",
        statusCategory: "new",
        updatedAt: hoursAgo(14),
      },
      {
        key: "EMOPS-241",
        summary: "Preference centre opt-down wiring — missed tag",
        assignee: "Jan Bartončík",
        priority: "Medium",
        status: "In Progress",
        statusCategory: "indeterminate",
        updatedAt: daysAgo(1.3),
      },
    ],
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql:
      "(project = EMAIL) AND status changed TO " +
      "(\"Done\", \"Closed\", \"Resolved\") AFTER \"-30d\"",
    preview: true,
  };
}

function buildDemoKanban() {
  const hoursAgo = (n) => new Date(now - n * 3600 * 1000).toISOString();
  const daysAgo = (n) => new Date(now - n * 86400 * 1000).toISOString();

  return {
    total: 23,
    maxPerColumn: 6,
    boardUrl:
      "https://jira.corp.nortonlifelock.com/secure/RapidBoard.jspa?rapidView=101032",
    columns: [
      {
        name: "To Do",
        statusCategory: "new",
        total: 7,
        truncated: 1,
        tickets: [
          {
            key: "EMOPS-311",
            summary: "Q2 launch — hero banner copy variants (EN-US / EN-GB)",
            assignee: "Iryna Botulinska",
            priority: "High",
            status: "To Do",
            statusCategory: "new",
            issueType: "Task",
            updatedAt: hoursAgo(2),
          },
          {
            key: "EMOPS-309",
            summary: "Segment win-back cohort for inactive 90+ day subs",
            assignee: "Kristýna Šimková",
            priority: "Medium",
            status: "To Do",
            statusCategory: "new",
            issueType: "Task",
            updatedAt: hoursAgo(5),
          },
          {
            key: "EMOPS-307",
            summary: "Legal review for renewal reminder footer",
            assignee: "Jan Bartončík",
            priority: "High",
            status: "To Do",
            statusCategory: "new",
            issueType: "Story",
            updatedAt: hoursAgo(7),
          },
          {
            key: "EMOPS-304",
            summary: "Darkmode-safe logo lockup for Outlook rendering",
            assignee: "Victor Shapochkin",
            priority: "Medium",
            status: "To Do",
            statusCategory: "new",
            issueType: "Task",
            updatedAt: daysAgo(1),
          },
          {
            key: "EMOPS-299",
            summary: "A11y: alt-text audit across April sends",
            assignee: "Daniel Žabenský",
            priority: "Low",
            status: "To Do",
            statusCategory: "new",
            issueType: "Task",
            updatedAt: daysAgo(2),
          },
          {
            key: "EMOPS-297",
            summary: "UTM convention refresh for paid cross-promo",
            assignee: "Yanina Scholz",
            priority: "Low",
            status: "To Do",
            statusCategory: "new",
            issueType: "Task",
            updatedAt: daysAgo(3),
          },
        ],
      },
      {
        name: "In Progress",
        statusCategory: "indeterminate",
        total: 6,
        truncated: 0,
        tickets: [
          {
            key: "EMOPS-315",
            summary: "Urgent: deliverability dip — Yahoo postmaster spike",
            assignee: "Petr Studený",
            priority: "Critical",
            status: "In Progress",
            statusCategory: "indeterminate",
            issueType: "Incident",
            updatedAt: hoursAgo(0.5),
          },
          {
            key: "EMOPS-314",
            summary: "Rebuild renewal journey in Braze — send-time optimisation",
            assignee: "Iryna Botulinska",
            priority: "High",
            status: "In Progress",
            statusCategory: "indeterminate",
            issueType: "Story",
            updatedAt: hoursAgo(1),
          },
          {
            key: "EMOPS-312",
            summary: "Monthly newsletter template — modular blocks v2",
            assignee: "Victor Shapochkin",
            priority: "Medium",
            status: "In Progress",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: hoursAgo(3),
          },
          {
            key: "EMOPS-308",
            summary: "Localisation pipeline — CZ / DE / IT sign-offs",
            assignee: "Jan Bartončík",
            priority: "Medium",
            status: "In Progress",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: hoursAgo(6),
          },
          {
            key: "EMOPS-306",
            summary: "Attribution window: align with Norton.com dashboards",
            assignee: "Daniel Žabenský",
            priority: "High",
            status: "In Progress",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: daysAgo(1),
          },
          {
            key: "EMOPS-302",
            summary: "Suppression list cleanup — bounce threshold rules",
            assignee: "Kristýna Šimková",
            priority: "Medium",
            status: "In Progress",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: daysAgo(2),
          },
        ],
      },
      {
        name: "In Review",
        statusCategory: "indeterminate",
        total: 5,
        truncated: 0,
        tickets: [
          {
            key: "EMOPS-305",
            summary: "QA sign-off: April security digest — multi-client render",
            assignee: "Yanina Scholz",
            priority: "High",
            status: "In Review",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: hoursAgo(1.5),
          },
          {
            key: "EMOPS-303",
            summary: "Copy review — renewal promo with 30% LTV lift",
            assignee: "Iryna Botulinska",
            priority: "High",
            status: "In Review",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: hoursAgo(4),
          },
          {
            key: "EMOPS-301",
            summary: "Design approval — cross-promo creative set (April)",
            assignee: "Victor Shapochkin",
            priority: "Medium",
            status: "In Review",
            statusCategory: "indeterminate",
            issueType: "Story",
            updatedAt: hoursAgo(8),
          },
          {
            key: "EMOPS-298",
            summary: "Accessibility sign-off: contrast + landmark roles",
            assignee: "Daniel Žabenský",
            priority: "Medium",
            status: "In Review",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: daysAgo(1),
          },
          {
            key: "EMOPS-295",
            summary: "Segmentation preview — win-back variant B",
            assignee: "Kristýna Šimková",
            priority: "Low",
            status: "In Review",
            statusCategory: "indeterminate",
            issueType: "Task",
            updatedAt: daysAgo(2),
          },
        ],
      },
      {
        name: "Done",
        statusCategory: "done",
        total: 5,
        truncated: 0,
        tickets: [
          {
            key: "EMOPS-293",
            summary: "Send: April trust-and-safety digest (1.1M recipients)",
            assignee: "Petr Studený",
            priority: "High",
            status: "Done",
            statusCategory: "done",
            issueType: "Task",
            updatedAt: hoursAgo(12),
          },
          {
            key: "EMOPS-290",
            summary: "Template: loyalty upgrade CTA block",
            assignee: "Victor Shapochkin",
            priority: "Medium",
            status: "Done",
            statusCategory: "done",
            issueType: "Task",
            updatedAt: daysAgo(1),
          },
          {
            key: "EMOPS-287",
            summary: "Link tracking: GA4 sync for consumer sends",
            assignee: "Daniel Žabenský",
            priority: "Medium",
            status: "Done",
            statusCategory: "done",
            issueType: "Task",
            updatedAt: daysAgo(2),
          },
          {
            key: "EMOPS-284",
            summary: "Opt-down survey — preference centre v2 wiring",
            assignee: "Jan Bartončík",
            priority: "Medium",
            status: "Done",
            statusCategory: "done",
            issueType: "Story",
            updatedAt: daysAgo(3),
          },
          {
            key: "EMOPS-280",
            summary: "Archive legacy welcome series — route to new journey",
            assignee: "Iryna Botulinska",
            priority: "Low",
            status: "Done",
            statusCategory: "done",
            issueType: "Task",
            updatedAt: daysAgo(4),
          },
        ],
      },
    ],
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql: "project = EMOPS AND filter = 'Norton Email Kanban' ORDER BY Rank",
    preview: true,
  };
}

function buildDemoThroughput() {
  const trend = [98, 104, 120, 131, 117, 112, 118, 124];
  const resolved = trend[trend.length - 1];
  const previous = trend[trend.length - 2];
  const deltaAbs = resolved - previous;
  const deltaPct =
    previous > 0 ? Math.round(((deltaAbs / previous) * 100) * 10) / 10 : 0;
  const trendLabels = [
    "2026-W08",
    "2026-W09",
    "2026-W10",
    "2026-W11",
    "2026-W12",
    "2026-W13",
    "2026-W14",
    "2026-W15",
  ];
  return {
    weekLabel: "2026-W15",
    weekRange: "7 Apr – 13 Apr",
    resolved,
    previous,
    deltaAbs,
    deltaPct,
    trend,
    trendLabels,
    generatedAt: Date.now(),
    timezone: TEAM_TIMEZONE,
    jql: "project = EMAIL AND statusCategory = Done AND resolved >= startOfWeek(-1) AND resolved < startOfWeek()",
    preview: true,
  };
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    fs.readFile(INDEX_HTML_PATH, "utf8", (err, html) => {
      if (err) {
        sendText(res, 500, `Failed to read index.html: ${err.message}`);
        return;
      }
      sendHtml(res, html.replaceAll("{{BRAND_NAME}}", BRAND_NAME));
    });
    return;
  }

  if (pathname === "/api/team") {
    sendJson(res, 200, buildDemoPayload());
    return;
  }

  if (pathname === "/api/absences") {
    const url = new URL(req.url, "http://localhost");
    const days = Math.max(
      1,
      Math.min(30, Number(url.searchParams.get("days") ?? 7) || 7)
    );
    sendJson(res, 200, buildDemoAbsences({ days }));
    return;
  }

  // All widget routes take ?project=EMOPS|EMAILCO|all — demo data
  // is the same but the filter drawer shows scoped env-var names so
  // the switcher UX is testable without real Jira.
  const project = parseProjectParam(req.url);

  if (pathname === "/api/widgets/weekly-throughput") {
    sendJson(
      res,
      200,
      withDemoFilter("weekly-throughput", buildDemoThroughput(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/backlog-overview") {
    sendJson(
      res,
      200,
      withDemoFilter("backlog-overview", buildDemoBacklog(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/ticket-lifecycle") {
    sendJson(
      res,
      200,
      withDemoFilter("ticket-lifecycle", buildDemoLifecycle(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/kanban-board") {
    sendJson(
      res,
      200,
      withDemoFilter("kanban-board", buildDemoKanban(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/inflow-vs-resolved") {
    sendJson(
      res,
      200,
      withDemoFilter("inflow-vs-resolved", buildDemoInflowVsResolved(), {
        project,
      })
    );
    return;
  }

  if (pathname === "/api/widgets/sla-aging-risk") {
    sendJson(
      res,
      200,
      withDemoFilter("sla-aging-risk", buildDemoSlaAgingRisk(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/top-priority-tickets") {
    sendJson(
      res,
      200,
      withDemoFilter("top-priority-tickets", buildDemoTopPriorityTickets(), {
        project,
      })
    );
    return;
  }

  if (pathname === "/api/widgets/sprint-backlog") {
    sendJson(
      res,
      200,
      withDemoFilter("sprint-backlog", buildDemoSprintBacklog(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/reopen-rate") {
    sendJson(
      res,
      200,
      withDemoFilter("reopen-rate", buildDemoReopenRate(), { project })
    );
    return;
  }

  if (pathname === "/api/widgets/throughput-leaderboard") {
    sendJson(
      res,
      200,
      withDemoFilter(
        "throughput-leaderboard",
        buildDemoThroughputLeaderboard(),
        { project }
      )
    );
    return;
  }

  if (pathname === "/api/jira-projects") {
    sendJson(res, 200, {
      projects: DEMO_PROJECTS,
      defaultProject: "EMOPS",
      allProjectKey: "all",
    });
    return;
  }

  if (pathname === "/api/widgets") {
    sendJson(res, 200, {
      widgets: [
        {
          id: "weekly-throughput",
          title: "Norton EMAIL Reports — Weekly throughput",
          size: "2x1",
          dataEndpoint: "/api/widgets/weekly-throughput",
          refreshSeconds: 900,
        },
        {
          id: "backlog-overview",
          title: "Norton Email — Backlog Overview",
          size: "1x1",
          dataEndpoint: "/api/widgets/backlog-overview",
          refreshSeconds: 900,
        },
        {
          id: "ticket-lifecycle",
          title: "Norton Email — Average Ticket Lifecycle",
          size: "1x1",
          dataEndpoint: "/api/widgets/ticket-lifecycle",
          refreshSeconds: 1800,
        },
        {
          id: "inflow-vs-resolved",
          title: "Norton Email — Inflow vs Resolved",
          size: "1x1",
          dataEndpoint: "/api/widgets/inflow-vs-resolved",
          refreshSeconds: 900,
        },
        {
          id: "sla-aging-risk",
          title: "Norton Email — SLA / Aging Risk",
          size: "1x1",
          dataEndpoint: "/api/widgets/sla-aging-risk",
          refreshSeconds: 300,
        },
        {
          id: "sprint-backlog",
          title: "Norton Email — CSM Sprint Backlog",
          size: "1x1",
          dataEndpoint: "/api/widgets/sprint-backlog",
          refreshSeconds: 300,
        },
        {
          id: "reopen-rate",
          title: "Norton Email — Reopen / Escalation Rate",
          size: "1x1",
          dataEndpoint: "/api/widgets/reopen-rate",
          refreshSeconds: 900,
        },
        {
          id: "top-priority-tickets",
          title: "Norton Email — Top Priority Tickets",
          size: "3x1",
          dataEndpoint: "/api/widgets/top-priority-tickets",
          refreshSeconds: 300,
        },
        {
          id: "throughput-leaderboard",
          title: "Norton Email — Team Throughput Leaderboard",
          size: "3x1",
          dataEndpoint: "/api/widgets/throughput-leaderboard",
          refreshSeconds: 900,
        },
        {
          id: "kanban-board",
          title: "Norton Email — Kanban Snapshot",
          size: "3x1",
          dataEndpoint: "/api/widgets/kanban-board",
          refreshSeconds: 180,
        },
        {
          id: "team-presence",
          title: "Team presence",
          size: "3x2",
          dataEndpoint: "/api/team",
          refreshSeconds: 30,
        },
      ],
    });
    return;
  }

  if (pathname === "/api/me") {
    sendJson(res, 200, {
      userId: "UDEMOKEV01",
      displayName: "Kevin Mold",
      firstName: "Kevin",
      title: "Manager, Online Marketing",
      team: "EMAIL Norton",
      email: "kevin.mold@gendigital.com",
      avatarUrl: null,
      initials: "KM",
      roles: ["any", "email", "manager"],
      profileUrl: "https://gencentral.gen.com/people/kevin.mold",
      canCustomize: true,
      preview: true,
    });
    return;
  }

  if (pathname === "/healthz") {
    sendText(res, 200, "ok");
    return;
  }

  // Serve static assets under /public/ — currently just team headshots
  // under /team/*.png. Paths are hardened against traversal.
  if (pathname.startsWith("/team/")) {
    const rel = pathname.replace(/^\/+/, "");
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        sendText(res, 404, "Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
          ? "image/webp"
          : "application/octet-stream";
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": "public, max-age=3600",
      });
      res.end(buf);
    });
    return;
  }

  sendText(res, 404, "Not found");
});

// Bind to 0.0.0.0 by default so the dashboard is reachable from
// phones / tablets on the same WiFi. Set PREVIEW_HOST=127.0.0.1 to
// restrict to the local machine only.
const HOST = process.env.PREVIEW_HOST ?? "0.0.0.0";

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}`];
  if (HOST === "0.0.0.0") {
    try {
      const nets = os.networkInterfaces();
      for (const ifaces of Object.values(nets)) {
        for (const iface of ifaces ?? []) {
          if (iface.family === "IPv4" && !iface.internal) {
            urls.push(`http://${iface.address}:${PORT}`);
          }
        }
      }
    } catch {}
  }
  // eslint-disable-next-line no-console
  console.log(
    `[preview] ${BRAND_NAME} dashboard preview (tz ${TEAM_TIMEZONE}):\n  - ${urls.join("\n  - ")}`
  );
});
