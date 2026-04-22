/**
 * Per-widget filter metadata — single source of truth for how
 * environment variables and runtime config map to human-readable
 * filter descriptions.
 *
 * Every Jira widget returns a `filter` object alongside its data, so
 * CSM teams can verify EXACTLY what is being queried and why the
 * numbers look the way they do. Without this, a widget that silently
 * fell back to a default JQL (e.g. top-priority falling back from
 * JIRA_TOP_PRIORITY_JQL → JIRA_KANBAN_JQL → JIRA_BACKLOG_JQL) would be
 * impossible to audit from the UI.
 *
 * Shape:
 *   {
 *     widgetId,                  // "weekly-throughput"
 *     title,                     // "Weekly throughput"  (short, for the chip)
 *     jql,                       // the JQL actually executed
 *     source,                    // env var that was resolved, e.g. "JIRA_THROUGHPUT_JQL"
 *     fallbackFrom,              // env var it *would* have come from if unset (null when source matches)
 *     refreshSeconds,            // cache TTL -> drives "refreshes every X" copy
 *     parameters: [              // structured, humans-first list
 *       { label, value, hint? }
 *     ],
 *     boardUrl,                  // optional Jira link
 *     project,                   // parsed out of JQL for the chip summary
 *     generatedAt,               // ms timestamp echoed from the payload
 *   }
 *
 * Design note: parameters are intentionally simple `{label, value}`
 * pairs — the UI renders them as a two-column list with zero logic.
 * Adding a new knob is one entry here + one label in the drawer CSS.
 */

/** Try to extract `project = FOO` (or IN (A, B)) from a JQL string. */
function extractProject(jql) {
  if (!jql) return null;
  const single = jql.match(/project\s*=\s*"?([A-Z][A-Z0-9_-]*)"?/i);
  if (single) return single[1];
  const inList = jql.match(/project\s+in\s*\(([^)]+)\)/i);
  if (inList) {
    return inList[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .join(", ");
  }
  return null;
}

/** Try to extract `issuetype in (...)` or `issuetype = X` from JQL. */
function extractIssueTypes(jql) {
  if (!jql) return null;
  const inList = jql.match(/issuetype\s+in\s*\(([^)]+)\)/i);
  if (inList) {
    return inList[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  const single = jql.match(/issuetype\s*=\s*"?([^"\s)]+)"?/i);
  if (single) return [single[1]];
  return null;
}

/** Try to extract `labels in (...)` or `labels = X` from JQL. */
function extractLabels(jql) {
  if (!jql) return null;
  const inList = jql.match(/labels\s+in\s*\(([^)]+)\)/i);
  if (inList) {
    return inList[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  const single = jql.match(/labels\s*=\s*"?([^"\s)]+)"?/i);
  if (single) return [single[1]];
  return null;
}

/** Try to extract `assignee in (...)` or `assignee = X` from JQL. */
function extractAssignee(jql) {
  if (!jql) return null;
  const notEmpty = /assignee\s+is\s+not\s+EMPTY/i.test(jql);
  const inList = jql.match(/assignee\s+in\s*\(([^)]+)\)/i);
  if (inList) {
    const list = inList[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    return list.length === 0 ? "any" : list.join(", ");
  }
  const single = jql.match(/assignee\s*=\s*"?([^"\s)]+)"?/i);
  if (single) return single[1];
  if (notEmpty) return "any (assigned)";
  return "any";
}

/** Short human label for an IANA tz, e.g. "Europe/Prague". */
function tzShort(tz) {
  if (!tz) return "UTC";
  return tz;
}

/** Build a short chip summary: "EMAIL · last 8w · resolved". */
function chipSummary({ project, windowLabel, verb }) {
  return [project, windowLabel, verb].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------ *
 * Per-widget filter builders.
 *
 * Each function takes a config blob (the resolved env-var values from
 * web.js) and returns the filter metadata object the UI will render.
 * They are pure functions — no IO, no side-effects — so preview.js
 * and web.js can both call them with the same signatures.
 * ------------------------------------------------------------------ */

export function filterForWeeklyThroughput({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "weekly-throughput",
    title: "Weekly throughput",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: "last 8 weeks",
      verb: "resolved",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Date field", value: "resolved" },
      {
        label: "Window",
        value: "Last 8 completed Mon–Sun weeks",
        hint: `Timezone: ${tzShort(timezone)}`,
      },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
    ],
  };
}

export function filterForBacklogOverview({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "backlog-overview",
    title: "Backlog overview",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: "snapshot",
      verb: "open",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      {
        label: "Scope",
        value: "Currently open (status category != Done)",
        hint: "Compared with 7-day-ago snapshot for delta",
      },
      {
        label: "Age buckets",
        value: "≤7d · 7–30d · 30–90d · 90d+",
      },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForTicketLifecycle({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  lookbackDays,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "ticket-lifecycle",
    title: "Ticket lifecycle",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: `last ${lookbackDays}d`,
      verb: "resolved",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Scope", value: `Tickets resolved in the last ${lookbackDays} days` },
      { label: "Metric", value: "Median age (created → resolved), by priority" },
      { label: "Comparison window", value: `Preceding ${lookbackDays} days` },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForInflowVsResolved({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "inflow-vs-resolved",
    title: "Inflow vs resolved",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: "last 8 weeks",
      verb: "inflow vs resolved",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Date fields", value: "created (inflow) · resolved (resolved)" },
      { label: "Window", value: "Last 8 completed Mon–Sun weeks" },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForSlaAgingRisk({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  thresholds,
  timezone,
  generatedAt,
}) {
  const thresholdLine = thresholds
    ? Object.entries(thresholds)
        .map(([p, d]) => `${p}: ${d}d`)
        .join(" · ")
    : "(defaults)";
  return {
    widgetId: "sla-aging-risk",
    title: "SLA / aging risk",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: "open tickets",
      verb: "SLA risk",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Scope", value: "Open tickets only (same pool as backlog)" },
      {
        label: "Thresholds (days)",
        value: thresholdLine,
        hint: "Per-priority target age before a ticket is flagged breaching / imminent / warning",
      },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForKanban({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  columns,
  boardUrl,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "kanban-board",
    title: "Kanban snapshot",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: boardUrl ?? null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: "board view",
      verb: "live",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      {
        label: "Columns",
        value:
          columns && columns.length > 0
            ? columns.join(" → ")
            : "(auto: distinct statuses on board)",
      },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Board URL", value: boardUrl ?? "(not configured)" },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForTopPriority({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  priorities,
  status,
  limit,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "top-priority-tickets",
    title: "Top priority tickets",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: `status: ${status}`,
      verb: `top ${limit}`,
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Status filter", value: status },
      {
        label: "Priorities shown",
        value: (priorities && priorities.length > 0
          ? priorities
          : ["Highest", "Critical", "High"]
        ).join(" · "),
      },
      { label: "Max rows", value: String(limit ?? 6) },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForSprintBacklog({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  status,
  boardUrl,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "sprint-backlog",
    title: "Sprint backlog",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: boardUrl ?? null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: `status: ${status}`,
      verb: "pipeline",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Status filter", value: status },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Board URL", value: boardUrl ?? "(not configured)" },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForReopenRate({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  doneStatuses,
  windowDays,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "reopen-rate",
    title: "Reopen / escalation rate",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: `last ${windowDays}d`,
      verb: "reopened",
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Window", value: `Last ${windowDays} days` },
      {
        label: "Done statuses",
        value: (doneStatuses ?? ["Done", "Closed", "Resolved"]).join(" · "),
        hint: "A ticket counts as reopened when it leaves one of these statuses",
      },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

export function filterForThroughputLeaderboard({
  jql,
  source,
  fallbackFrom = null,
  refreshSeconds,
  limit,
  timezone,
  generatedAt,
}) {
  return {
    widgetId: "throughput-leaderboard",
    title: "Team throughput leaderboard",
    jql,
    source,
    fallbackFrom,
    refreshSeconds,
    project: extractProject(jql),
    boardUrl: null,
    generatedAt,
    chip: chipSummary({
      project: extractProject(jql),
      windowLabel: "last 8 weeks",
      verb: `top ${limit ?? 6}`,
    }),
    parameters: [
      { label: "Project", value: extractProject(jql) ?? "(none in JQL)" },
      { label: "Date field", value: "resolved" },
      { label: "Window", value: "Last 8 completed Mon–Sun weeks" },
      { label: "Ranking", value: "Resolved count per assignee (last week)" },
      { label: "Max rows", value: String(limit ?? 6) },
      {
        label: "Issue types",
        value: extractIssueTypes(jql)?.join(", ") ?? "(all)",
      },
      { label: "Labels", value: extractLabels(jql)?.join(", ") ?? "(none)" },
      { label: "Assignee scope", value: extractAssignee(jql) },
      { label: "Timezone", value: tzShort(timezone) },
    ],
  };
}

/**
 * Single source of truth: map widget id -> filter builder.
 * Used by preview.js to get filter meta for demo data.
 */
export const FILTER_BUILDERS = {
  "weekly-throughput": filterForWeeklyThroughput,
  "backlog-overview": filterForBacklogOverview,
  "ticket-lifecycle": filterForTicketLifecycle,
  "inflow-vs-resolved": filterForInflowVsResolved,
  "sla-aging-risk": filterForSlaAgingRisk,
  "kanban-board": filterForKanban,
  "top-priority-tickets": filterForTopPriority,
  "sprint-backlog": filterForSprintBacklog,
  "reopen-rate": filterForReopenRate,
  "throughput-leaderboard": filterForThroughputLeaderboard,
};
