import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM, rosterMember } from "./team.js";

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

function buildDemoPayload() {
  const date = todayInTz();

  // Seed a visually interesting board by attaching a plausible state to
  // each roster slug. Keeps real names + headshots in preview mode.
  const seeds = {
    "iryna-botulinska": {
      id: "U001",
      checkin: { state: "in", note: null, updatedAt: minsAgo(125) },
      presence: {
        state: "available",
        note: null,
        untilTs: null,
        updatedAt: minsAgo(125),
      },
    },
    "victor-shapochkin": {
      id: "U002",
      checkin: { state: "wfh", note: "Focus day on Q2 launch", updatedAt: minsAgo(95) },
      presence: {
        state: "available",
        note: "WFH — Focus day on Q2 launch",
        untilTs: null,
        updatedAt: minsAgo(95),
      },
    },
    "petr-studeny": {
      id: "U003",
      checkin: { state: "late", note: "Train delay", updatedAt: minsAgo(40) },
      presence: {
        state: "away",
        note: "Running late — Train delay",
        untilTs: hoursAhead(1),
        updatedAt: minsAgo(40),
      },
    },
    "jan-bartoncik": {
      id: "U004",
      checkin: { state: "sick", note: "Flu", updatedAt: minsAgo(310) },
      presence: {
        state: "ooo",
        note: "Flu",
        untilTs: null,
        updatedAt: minsAgo(310),
      },
    },
    "kristyna-simkova": {
      id: "U005",
      checkin: { state: "pto", note: "Annual leave", updatedAt: minsAgo(1440) },
      presence: {
        state: "ooo",
        note: "Annual leave",
        untilTs: null,
        updatedAt: minsAgo(1440),
      },
    },
    "daniel-zabensky": {
      id: "U006",
      checkin: { state: "in", note: null, updatedAt: minsAgo(60) },
      presence: {
        state: "away",
        note: "In meeting: Campaign review",
        untilTs: hoursAhead(0.5),
        updatedAt: minsAgo(10),
      },
    },
    "yanina-scholz": {
      id: "U007",
      checkin: null,
      presence: null,
    },
    "volodymyr-yatsenko": {
      id: "U008",
      checkin: { state: "wfh", note: "CS escalations queue", updatedAt: minsAgo(210) },
      presence: {
        state: "available",
        note: "WFH — CS escalations queue",
        untilTs: null,
        updatedAt: minsAgo(210),
      },
    },
  };

  const members = TEAM
    .map((m) => rosterMember(m.slug, seeds[m.slug] ?? { id: m.slug }))
    .filter(Boolean);

  const rollcalls = [
    {
      id: "a1b2c3d4e5f6",
      title: "Monday stand-up",
      createdAt: minsAgo(180),
      channelId: "C100",
      counts: { attending: 6, late: 1, absent: 1 },
      totalResponses: 8,
    },
    {
      id: "b7c8d9e0f1a2",
      title: "Campaign review",
      createdAt: minsAgo(45),
      channelId: "C100",
      counts: { attending: 4, late: 1, absent: 0 },
      totalResponses: 5,
    },
  ];

  return {
    brandName: BRAND_NAME,
    date,
    timezone: TEAM_TIMEZONE,
    generatedAt: Date.now(),
    members,
    rollcalls,
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

  if (pathname === "/api/widgets/weekly-throughput") {
    sendJson(res, 200, buildDemoThroughput());
    return;
  }

  if (pathname === "/api/widgets/backlog-overview") {
    sendJson(res, 200, buildDemoBacklog());
    return;
  }

  if (pathname === "/api/widgets/ticket-lifecycle") {
    sendJson(res, 200, buildDemoLifecycle());
    return;
  }

  if (pathname === "/api/widgets/kanban-board") {
    sendJson(res, 200, buildDemoKanban());
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

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[preview] ${BRAND_NAME} dashboard preview on http://localhost:${PORT} (tz ${TEAM_TIMEZONE})`
  );
});
