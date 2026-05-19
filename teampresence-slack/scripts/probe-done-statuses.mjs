// =============================================================================
// probe-done-statuses.mjs
// -----------------------------------------------------------------------------
// Mirrors what reopen-rate assumes: that tickets resolved in the last 30d
// are findable via `status changed TO ("Done","Closed","Resolved")`. Some
// Jira workflows finalise to non-default names ("Production","Live",
// "Won't Do", "Cancelled", "Deployed") and those would silently drop
// out of the reopen-rate denominator.
//
// We probe both ways:
//   1. Count tickets that landed in any Done-category status in the last
//      30 days (statusCategory = Done) — the ground truth.
//   2. Count tickets that landed in literally Done/Closed/Resolved over
//      the same window — what reopen-rate currently asks for.
// If (2) is meaningfully lower than (1), we're missing finals.
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { JiraClient } from "../src/jira.js";
import { applyTeamScope, resolveJql } from "../src/jira-projects.js";

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
const jira = new JiraClient({ baseUrl: env.JIRA_BASE_URL, token: env.JIRA_TOKEN });

for (const project of ["EMOPS", "EMAILCO"]) {
  console.log("\n=== " + project + " ===");
  const { jql: baseJql } = resolveJql(env, project, "REOPEN");
  const { jql: scoped } = applyTeamScope(baseJql, env, project);

  const groundTruthJql =
    `(${scoped}) AND statusCategory = Done AND resolved >= -30d`;
  const namedJql =
    `(${scoped}) AND status changed TO ("Done","Closed","Resolved") AFTER "-30d"`;

  const [groundTruth, named] = await Promise.all([
    jira.searchCount(groundTruthJql).catch((e) => `! ${e.message.split(":")[0]}`),
    jira.searchCount(namedJql).catch((e) => `! ${e.message.split(":")[0]}`),
  ]);

  console.log(`  resolved in last 30d (statusCategory=Done): ${groundTruth}`);
  console.log(`  reached Done|Closed|Resolved literally:     ${named}`);

  if (typeof groundTruth === "number" && typeof named === "number") {
    const drift = groundTruth - named;
    if (Math.abs(drift) <= Math.max(2, groundTruth * 0.05)) {
      console.log(`  ✓ within 5% — reopen-rate denominator is correct.`);
    } else {
      console.log(
        `  ✗ drift = ${drift}. Sample what's missing:`
      );
      const sample = await jira.search(
        `(${scoped}) AND statusCategory = Done AND resolved >= -30d AND status not in ("Done","Closed","Resolved")`,
        { fields: ["status"], maxResults: 30 }
      );
      const histo = new Map();
      for (const i of sample.issues) {
        const n = i.fields?.status?.name ?? "(none)";
        histo.set(n, (histo.get(n) ?? 0) + 1);
      }
      for (const [name, count] of [...histo.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`     ${String(count).padStart(4)}  ${name}`);
      }
    }
  }
}

console.log("\nDone.");
