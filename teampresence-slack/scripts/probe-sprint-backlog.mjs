// =============================================================================
// probe-sprint-backlog.mjs
// -----------------------------------------------------------------------------
// One-off diagnostic. Asks: "Does the team genuinely have nothing in the
// To-Do queue, or does the workflow just not use the literal status name
// 'To Do'?" — different Jira workflows label the same column 'Open',
// 'Selected for Development', 'Ready', 'Backlog', 'New', etc.
//
// What it does:
//   1. Loads .env (no .env loader dep; we only need a few keys).
//   2. Constructs the *same* team-scoped JQL the widget uses, but WITHOUT
//      the status filter.
//   3. Counts all issues (statusCategory != Done) per project.
//   4. Pulls a sample of up to 200 of those issues and tallies their
//      `status.name` values, so we can see exactly what the open queue
//      looks like — including the actual status name(s) the team uses
//      for "to be picked up next".
//   5. Tries a handful of common alternative names and prints the count
//      for each, so picking the right SPRINT_BACKLOG_STATUS is one line.
//
// Read-only. Doesn't touch the server, doesn't write to .env.
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { JiraClient } from "../src/jira.js";
import {
  applyTeamScope,
  resolveJql,
} from "../src/jira-projects.js";

// Tiny .env loader: split on '=' (first only), strip surrounding quotes.
// Keeps the script dependency-free.
function loadEnv(file = path.resolve("./.env")) {
  const raw = readFileSync(file, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const env = { ...process.env, ...loadEnv() };
const projects = ["EMOPS", "EMAILCO", "all"];

const jira = new JiraClient({
  baseUrl: env.JIRA_BASE_URL,
  token: env.JIRA_TOKEN,
});

const COMMON_BACKLOG_STATUSES = [
  "To Do",
  "Open",
  "New",
  "Backlog",
  "Selected for Development",
  "Ready",
  "Ready for Development",
  "Ready to Start",
  "Triage",
  "Reopened",
];

function formatJql(jql) {
  return jql.length > 220 ? jql.slice(0, 217) + "..." : jql;
}

for (const project of projects) {
  console.log("\n" + "=".repeat(78));
  console.log(`PROJECT = ${project}`);
  console.log("=".repeat(78));

  // Build the same scope as the widget, minus the trailing AND status = ...
  const { jql: baseJql, source } = resolveJql(env, project, "SPRINT_BACKLOG");
  const { jql: scopedJql, applied } = applyTeamScope(baseJql, env, project);

  console.log(`source         : ${source}`);
  console.log(`team-scoped JQL: ${formatJql(scopedJql)}`);
  console.log(
    `team scope     : ${applied.map((a) => `${a.field} (${a.values.length} ${a.mode || "exclude"})`).join(", ")}`
  );

  // ── 1. total open ────────────────────────────────────────────────────────
  let totalOpen;
  try {
    totalOpen = await jira.searchCount(scopedJql);
  } catch (err) {
    console.log(`  ! search failed: ${err.message}`);
    continue;
  }
  console.log(`\nopen issues (statusCategory != Done) : ${totalOpen}`);

  // ── 2. status histogram from a sample ────────────────────────────────────
  const sample = await jira.searchAll(scopedJql, {
    fields: ["status"],
    pageSize: 100,
    hardCap: 200,
  });
  const histogram = new Map();
  for (const issue of sample) {
    const name = issue.fields?.status?.name ?? "(none)";
    histogram.set(name, (histogram.get(name) ?? 0) + 1);
  }
  const sorted = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    `\nstatuses present in first ${sample.length}/${totalOpen} open issues:`
  );
  for (const [name, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}  ${name}`);
  }
  if (totalOpen > sample.length) {
    console.log(`  (sample capped — totals above are out of ${sample.length})`);
  }

  // ── 3. count for each common "backlog" status name ───────────────────────
  console.log("\nliteral status counts (against full team scope):");
  for (const status of COMMON_BACKLOG_STATUSES) {
    const jql = `(${scopedJql}) AND status = "${status}"`;
    let n;
    try {
      n = await jira.searchCount(jql);
    } catch (err) {
      n = `! ${err.message.split(":")[0]}`;
    }
    const flag = status === "To Do" ? "  <- widget default" : "";
    console.log(`  ${String(n).padStart(4)}  status = "${status}"${flag}`);
  }
}

console.log("\nDone.");
