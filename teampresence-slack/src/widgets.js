/**
 * Widget manifest.
 *
 * Each widget is:
 *   { id, title, size, rolesAllowed, dataEndpoint, refreshSeconds }
 *
 * The front-end fetches /api/widgets to discover which widgets the caller
 * is allowed to see, then hits each widget's dataEndpoint on a refresh loop.
 *
 * For v1 the existing UI sections (KPIs / Team / Exceptions / Roll calls)
 * remain rendered inline, and NEW widgets (e.g. weekly-throughput) appear as
 * self-contained cards above them. The manifest is already the source of
 * truth so the next refactor is just markup reshuffling.
 */

export const WIDGETS = [
  {
    id: "weekly-throughput",
    title: "Norton EMAIL Reports — Weekly throughput",
    size: "2x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/weekly-throughput",
    refreshSeconds: 15 * 60,
  },
  {
    id: "backlog-overview",
    title: "Norton Email — Backlog Overview",
    size: "1x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/backlog-overview",
    refreshSeconds: 15 * 60,
  },
  {
    id: "ticket-lifecycle",
    title: "Norton Email — Average Ticket Lifecycle",
    size: "1x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/ticket-lifecycle",
    refreshSeconds: 30 * 60,
  },
  {
    id: "inflow-vs-resolved",
    title: "Norton Email — Inflow vs Resolved",
    size: "1x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/inflow-vs-resolved",
    refreshSeconds: 15 * 60,
  },
  {
    id: "sla-aging-risk",
    title: "Norton Email — SLA / Aging Risk",
    size: "1x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/sla-aging-risk",
    refreshSeconds: 5 * 60,
  },
  {
    id: "sprint-backlog",
    title: "Norton Email — CSM Sprint Backlog",
    size: "1x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/sprint-backlog",
    refreshSeconds: 5 * 60,
  },
  {
    id: "reopen-rate",
    title: "Norton Email — Reopen / Escalation Rate",
    size: "1x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/reopen-rate",
    refreshSeconds: 15 * 60,
  },
  {
    id: "top-priority-tickets",
    title: "Norton Email — Top Priority Tickets",
    size: "3x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/top-priority-tickets",
    refreshSeconds: 5 * 60,
  },
  {
    id: "throughput-leaderboard",
    title: "Norton Email — Team Throughput Leaderboard",
    size: "3x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/throughput-leaderboard",
    refreshSeconds: 15 * 60,
  },
  {
    id: "kanban-board",
    title: "Norton Email — Kanban Snapshot",
    size: "3x1",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/widgets/kanban-board",
    refreshSeconds: 3 * 60,
  },
  {
    id: "team-presence",
    title: "Team presence",
    size: "3x2",
    rolesAllowed: ["any"],
    dataEndpoint: "/api/team",
    refreshSeconds: 30,
  },
];

export function widgetById(id) {
  return WIDGETS.find((w) => w.id === id) ?? null;
}
