/**
 * Jira multi-project configuration.
 *
 * Why this module exists:
 *   The EMAIL NORTON team runs two Jira projects in parallel:
 *     - EMOPS    (current / primary)
 *     - EMAILCO  (older / legacy)
 *   …and each has meaningfully different filters for every widget.
 *   The dashboard needs to show them side-by-side via a project
 *   switcher (see public/index.html). Widget env vars therefore
 *   follow a per-project naming convention:
 *
 *     JIRA_EMOPS_THROUGHPUT_JQL = project = EMOPS AND …
 *     JIRA_EMAILCO_THROUGHPUT_JQL = project = EMAILCO AND …
 *
 *   …plus an optional "ALL" variant for directors who want the
 *   combined view:
 *
 *     JIRA_ALL_THROUGHPUT_JQL = project in (EMOPS, EMAILCO) AND …
 *
 *   If none of those are set we fall back to the original
 *   single-project env vars (`JIRA_THROUGHPUT_JQL`) so existing
 *   single-project deployments keep working unchanged.
 *
 * Public surface:
 *   - listProjects(env?)        → [{ key, label, isDefault }, …]
 *   - defaultProjectKey(env?)   → string
 *   - resolveJql(env?, projectKey, widgetKey) → { jql, source, fallbackFrom }
 *   - isValidProjectKey(env?, key) → boolean
 *
 * All functions accept `env` so tests can inject a fixture instead
 * of mutating process.env.
 */

const WIDGET_ENV_SUFFIXES = Object.freeze({
  THROUGHPUT: "THROUGHPUT_JQL",
  BACKLOG: "BACKLOG_JQL",
  LIFECYCLE: "LIFECYCLE_JQL",
  LIFECYCLE_PREV: "LIFECYCLE_PREV_JQL",
  INFLOW: "INFLOW_JQL",
  SLA: "SLA_JQL",
  KANBAN: "KANBAN_JQL",
  TOP_PRIORITY: "TOP_PRIORITY_JQL",
  SPRINT_BACKLOG: "SPRINT_BACKLOG_JQL",
  REOPEN: "REOPEN_JQL",
  LEADERBOARD: "LEADERBOARD_JQL",
});

// Fallback chain per widget. Each entry is "the next place to look
// if this project's specific var is empty". The first element is
// always the per-project var itself and is injected dynamically.
// Legacy single-project vars come last so the config is
// backwards-compatible.
const WIDGET_FALLBACKS = Object.freeze({
  THROUGHPUT: ["THROUGHPUT_JQL"],
  BACKLOG: ["BACKLOG_JQL"],
  LIFECYCLE: ["LIFECYCLE_JQL"],
  LIFECYCLE_PREV: ["LIFECYCLE_PREV_JQL"],
  INFLOW: ["INFLOW_JQL", "THROUGHPUT_JQL"],
  SLA: ["SLA_JQL", "BACKLOG_JQL"],
  KANBAN: ["KANBAN_JQL"],
  TOP_PRIORITY: ["TOP_PRIORITY_JQL", "KANBAN_JQL", "BACKLOG_JQL"],
  SPRINT_BACKLOG: ["SPRINT_BACKLOG_JQL", "KANBAN_JQL", "BACKLOG_JQL"],
  REOPEN: ["REOPEN_JQL", "THROUGHPUT_JQL", "BACKLOG_JQL"],
  LEADERBOARD: ["LEADERBOARD_JQL", "THROUGHPUT_JQL", "BACKLOG_JQL"],
});

// Reserved project key used to denote the "combined" / "all" view.
// Not a real Jira project; the switcher surfaces it separately.
export const ALL_PROJECT_KEY = "all";

// Reserved team key for the default (Norton Email) team. When no
// team is selected, the code path behaves exactly as before —
// team-agnostic env vars (JIRA_{PROJECT}_*) apply. This lets us
// add AVAST Freemium as a layered overlay without ever touching
// the Norton Email env vars or risking regression.
export const DEFAULT_TEAM_KEY = "norton";
export const AVAST_TEAM_KEY = "avast";
export const TEAM_KEYS = Object.freeze([DEFAULT_TEAM_KEY, AVAST_TEAM_KEY]);

export function isValidTeamKey(key) {
  if (!key) return false;
  const s = String(key).toLowerCase();
  return TEAM_KEYS.includes(s);
}

export function normaliseTeamKey(key) {
  const s = String(key ?? "").trim().toLowerCase();
  return isValidTeamKey(s) ? s : DEFAULT_TEAM_KEY;
}

function upperTeam(key) {
  return String(key || "").toUpperCase();
}

export const WIDGET_KEYS = Object.freeze(Object.keys(WIDGET_ENV_SUFFIXES));

function parseCsv(value) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function upperProject(key) {
  return String(key || "").toUpperCase();
}

/**
 * Return the list of projects the operator has declared, in the
 * order they appear in JIRA_PROJECT_KEYS. When no keys are set
 * returns an empty array — callers can treat that as
 * "single-project / legacy mode".
 *
 * `JIRA_PROJECT_KEYS=EMOPS,EMAILCO` + `JIRA_PROJECT_LABELS=EMOPS (current),EMAILCO (legacy)`
 * →
 * [
 *   { key: "EMOPS",   label: "EMOPS (current)", isDefault: true },
 *   { key: "EMAILCO", label: "EMAILCO (legacy)", isDefault: false },
 * ]
 *
 * When `JIRA_PROJECT_ALLOW_COMBINED=1` (default when there are 2+
 * keys), an extra entry with key="all" is appended so the UI can
 * render a "Both" tab.
 */
export function listProjects(env = process.env) {
  const keys = parseCsv(env.JIRA_PROJECT_KEYS).map(upperProject);
  if (keys.length === 0) return [];
  const labels = parseCsv(env.JIRA_PROJECT_LABELS);
  // Preserve the reserved ALL_PROJECT_KEY casing ("all" is lowercase by
  // convention); upper-case everything else so EMOPS / emops / Emops all
  // resolve to the same entry.
  const defaultKeyRaw = (env.JIRA_DEFAULT_PROJECT ?? keys[0]).trim();
  const defaultKey =
    defaultKeyRaw.toLowerCase() === ALL_PROJECT_KEY
      ? ALL_PROJECT_KEY
      : defaultKeyRaw.toUpperCase();
  const allowCombined =
    env.JIRA_PROJECT_ALLOW_COMBINED == null
      ? keys.length >= 2
      : env.JIRA_PROJECT_ALLOW_COMBINED !== "0" &&
        env.JIRA_PROJECT_ALLOW_COMBINED !== "false";

  const out = keys.map((key, i) => ({
    key,
    label: (labels[i] ?? key).trim() || key,
    isDefault: key === defaultKey,
  }));

  if (allowCombined) {
    out.push({
      key: ALL_PROJECT_KEY,
      label: env.JIRA_ALL_LABEL?.trim() || "Both",
      isDefault: defaultKey === ALL_PROJECT_KEY,
    });
  }

  // If nothing was marked default (e.g. JIRA_DEFAULT_PROJECT was
  // misspelled), guarantee the first concrete project is the
  // default so the UI has something to pick.
  if (!out.some((p) => p.isDefault)) {
    out[0].isDefault = true;
  }

  return out;
}

export function defaultProjectKey(env = process.env) {
  const list = listProjects(env);
  return list.find((p) => p.isDefault)?.key ?? null;
}

export function isValidProjectKey(env = process.env, key) {
  if (!key) return false;
  const list = listProjects(env);
  // Case-insensitive compare: real project keys are stored uppercase
  // ("EMOPS"), but the reserved combined key is lowercase ("all").
  // Callers may pass either; accept both forms for both.
  const needle = String(key).toLowerCase();
  return list.some((p) => p.key.toLowerCase() === needle);
}

/**
 * Resolve the JQL to use for a (project, widget) pair.
 *
 * Resolution order:
 *   1. JIRA_<PROJECT>_<WIDGET>_JQL
 *   2. JIRA_<PROJECT>_<FALLBACK_WIDGET>_JQL   (from WIDGET_FALLBACKS)
 *   3. JIRA_<WIDGET>_JQL                      (legacy single-project)
 *   4. JIRA_<FALLBACK_WIDGET>_JQL             (legacy single-project)
 *
 * Returns `{ jql, source, fallbackFrom }` where:
 *   - jql          : the resolved JQL string (may be "")
 *   - source       : the env var that supplied the JQL (or the
 *                    primary candidate when nothing matched)
 *   - fallbackFrom : the intended primary var when a later
 *                    candidate had to be used; null when the
 *                    primary var was itself non-empty
 */
export function resolveJql(env = process.env, projectKey, widgetKey) {
  if (!WIDGET_ENV_SUFFIXES[widgetKey]) {
    throw new Error(`resolveJql: unknown widgetKey "${widgetKey}"`);
  }
  const suffix = WIDGET_ENV_SUFFIXES[widgetKey];
  const proj = upperProject(projectKey);
  const fallbacks = WIDGET_FALLBACKS[widgetKey] ?? [suffix];

  const candidates = [];

  if (proj && proj !== ALL_PROJECT_KEY.toUpperCase()) {
    // Per-project primary + per-project fallbacks.
    for (const s of fallbacks) candidates.push(`JIRA_${proj}_${s}`);
  } else if (proj === ALL_PROJECT_KEY.toUpperCase()) {
    // "Combined" view: look for JIRA_ALL_* first, then fall back to
    // legacy single-project vars (which, in a multi-project deploy,
    // probably WON'T be set — that's intentional; it means the
    // combined view surfaces as "unavailable" until the operator
    // explicitly defines a combined JQL).
    for (const s of fallbacks) candidates.push(`JIRA_ALL_${s}`);
  }
  // Legacy single-project fallbacks (always considered last).
  for (const s of fallbacks) candidates.push(`JIRA_${s}`);

  const pairs = candidates.map((name) => [name, (env[name] ?? "").trim()]);
  const hit = pairs.find(([, v]) => v.length > 0);
  const primary = pairs[0];
  if (!hit) {
    return { jql: "", source: primary[0], fallbackFrom: null };
  }
  const [hitName, hitValue] = hit;
  return {
    jql: hitValue,
    source: hitName,
    fallbackFrom: hitName !== primary[0] ? primary[0] : null,
  };
}

/**
 * Apply team-scope exclusion clauses to an already-resolved JQL.
 *
 * EMOPS and EMAILCO are shared Jira projects. The Norton Email team
 * and e.g. the Avast Freemium team both file tickets into them, so a
 * naive `project = EMOPS AND statusCategory != Done` surfaces every
 * other team's cards on our kanban / throughput / backlog.
 *
 * Rather than keep a positive include-list (which has to track every
 * new extended team member we onboard), we maintain a small negative
 * exclude-list of the *other* team's signals — their assignees and
 * their product labels/components. Unassigned work stays visible
 * (most EMOPS intake is unassigned at the Request stage), and
 * everyone on our extended team stays visible without having to be
 * explicitly enrolled.
 *
 * The wrapper is purely additive — existing JQL is untouched, we
 * just AND-append:
 *
 *     (assignee is EMPTY OR assignee not in ("Kamila Královcová", …))
 *     AND (labels is EMPTY OR labels not in ("avast", "A1F"))
 *     AND (component is EMPTY OR component not in ("Avast Freemium"))
 *
 * Driven by three per-project env vars (all optional, all parsed as
 * comma-separated lists with quote/backslash-safe JQL escaping):
 *
 *     JIRA_<PROJECT>_EXCLUDE_ASSIGNEES
 *     JIRA_<PROJECT>_EXCLUDE_LABELS
 *     JIRA_<PROJECT>_EXCLUDE_COMPONENTS
 *     JIRA_<PROJECT>_INCLUDE_BUSINESS_TEAMS  (positive filter — Jira
 *       custom field "Business Team", aligns Gen Pulse with native
 *       gadgets that scope to the team's owned product streams.
 *       e.g. "Norton - LCM/AR, Norton - MR/PF, Product&Engineering")
 *
 * An empty env var means "no scope for this dimension"; the clause
 * is omitted entirely so the JQL stays minimal.
 *
 * Note on INCLUDE vs EXCLUDE semantics:
 *   - EXCLUDE_* lists are subtractive ("don't show me Kamila's team")
 *     and use `field is EMPTY OR field not in (…)` so unsized data
 *     (e.g. unassigned tickets) is preserved.
 *   - INCLUDE_BUSINESS_TEAMS is positive ("only show me my owned
 *     streams") and uses a strict `field in (…)` — tickets without
 *     a Business Team value are intentionally dropped, because that
 *     matches how Jira's stock "Throughput" gadget behaves when
 *     scoped on a multi-select field.
 */
export function applyTeamScope(
  jql,
  env = process.env,
  projectKey,
  { logger = console, teamKey = null } = {}
) {
  if (!jql || typeof jql !== "string") return { jql: jql ?? "", applied: [] };

  const includeAssignees = parseCsvScope(
    resolveProjectScalar(env, projectKey, "INCLUDE_ASSIGNEES", teamKey).value
  );
  const assignees = parseCsvScope(
    resolveProjectScalar(env, projectKey, "EXCLUDE_ASSIGNEES", teamKey).value
  );
  const labels = parseCsvScope(
    resolveProjectScalar(env, projectKey, "EXCLUDE_LABELS", teamKey).value
  );
  const components = parseCsvScope(
    resolveProjectScalar(env, projectKey, "EXCLUDE_COMPONENTS", teamKey).value
  );
  const businessTeams = parseCsvScope(
    resolveProjectScalar(env, projectKey, "INCLUDE_BUSINESS_TEAMS", teamKey).value
  );

  if (
    includeAssignees.length === 0 &&
    assignees.length === 0 &&
    labels.length === 0 &&
    components.length === 0 &&
    businessTeams.length === 0
  ) {
    return { jql, applied: [] };
  }

  const applied = [];
  const clauses = [`(${jql})`];

  if (includeAssignees.length > 0) {
    // Positive assignee filter — used for teams defined by their
    // positive roster (e.g. Avast Freemium). Unlike EXCLUDE_ASSIGNEES
    // this drops unassigned tickets intentionally; AVAST-team tickets
    // are expected to have a named owner once they reach a board. If
    // both INCLUDE_ and EXCLUDE_ are configured, INCLUDE_ wins and
    // EXCLUDE_ is ignored (they're contradictory by definition).
    const list = includeAssignees.map(jqlQuote).join(", ");
    clauses.push(`assignee in (${list})`);
    applied.push({ field: "assignee", values: includeAssignees, mode: "include" });
  } else if (assignees.length > 0) {
    const list = assignees.map(jqlQuote).join(", ");
    clauses.push(`(assignee is EMPTY OR assignee not in (${list}))`);
    applied.push({ field: "assignee", values: assignees, mode: "exclude" });
  }
  if (businessTeams.length > 0) {
    // "Business Team" is a custom field; JQL accesses it by quoted
    // display name. Strict membership (no "is EMPTY OR" branch) so
    // tickets with no Business Team are dropped — matches how Jira's
    // native gadget filters this dimension.
    const list = businessTeams.map(jqlQuote).join(", ");
    clauses.push(`"Business Team" in (${list})`);
    applied.push({ field: "Business Team", values: businessTeams, mode: "include" });
  }
  if (labels.length > 0) {
    const list = labels.map(jqlQuote).join(", ");
    clauses.push(`(labels is EMPTY OR labels not in (${list}))`);
    applied.push({ field: "labels", values: labels, mode: "exclude" });
  }
  if (components.length > 0) {
    const list = components.map(jqlQuote).join(", ");
    clauses.push(`(component is EMPTY OR component not in (${list}))`);
    applied.push({ field: "component", values: components, mode: "exclude" });
  }

  const wrapped = clauses.join(" AND ");
  logger.log?.(
    `[jira] team-scope applied to ${projectKey ?? "default"}` +
      (teamKey && teamKey !== DEFAULT_TEAM_KEY ? ` [team=${teamKey}]` : "") +
      ": " +
      applied
        .map((a) => `${a.field}×${a.values.length}${a.mode === "include" ? "↑" : "↓"}`)
        .join(", ")
  );
  return { jql: wrapped, applied };
}

function parseCsvScope(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/,|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function jqlQuote(v) {
  // JQL string escaping: backslash and double-quote are the only
  // characters we must escape. Wrap in double quotes.
  const escaped = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Fetch a scalar non-JQL env var, scoped by project and optionally team.
 *
 * Resolution order (most specific → most generic):
 *   1. JIRA_{TEAM}_{PROJECT}_{SUFFIX}   e.g. JIRA_AVAST_EMOPS_EXCLUDE_ASSIGNEES
 *   2. JIRA_{TEAM}_{SUFFIX}              e.g. JIRA_AVAST_EXCLUDE_ASSIGNEES
 *   3. JIRA_{PROJECT}_{SUFFIX}           e.g. JIRA_EMOPS_EXCLUDE_ASSIGNEES
 *   4. JIRA_{SUFFIX}                     e.g. JIRA_EXCLUDE_ASSIGNEES
 *
 * When teamKey is unset or equal to DEFAULT_TEAM_KEY ("norton") the
 * team-prefixed candidates are skipped so existing deployments are
 * byte-identical. Adding AVAST is therefore purely additive: set
 * the JIRA_AVAST_* env vars and the default view is unchanged.
 */
export function resolveProjectScalar(
  env = process.env,
  projectKey,
  suffix,
  teamKey = null
) {
  const proj = upperProject(projectKey);
  const team = upperTeam(teamKey);
  const teamIsOverlay = team && team !== upperTeam(DEFAULT_TEAM_KEY);

  // Team-scoped candidates (most specific → team-only).
  const teamCandidates = [];
  if (teamIsOverlay) {
    if (proj && proj !== ALL_PROJECT_KEY.toUpperCase()) {
      teamCandidates.push(`JIRA_${team}_${proj}_${suffix}`);
    } else if (proj === ALL_PROJECT_KEY.toUpperCase()) {
      teamCandidates.push(`JIRA_${team}_ALL_${suffix}`);
    }
    teamCandidates.push(`JIRA_${team}_${suffix}`);
  }
  // Global (team-agnostic) candidates.
  const globalCandidates = [];
  if (proj && proj !== ALL_PROJECT_KEY.toUpperCase()) {
    globalCandidates.push(`JIRA_${proj}_${suffix}`);
  } else if (proj === ALL_PROJECT_KEY.toUpperCase()) {
    globalCandidates.push(`JIRA_ALL_${suffix}`);
  }
  globalCandidates.push(`JIRA_${suffix}`);

  // For team overlays: an *explicitly set-but-empty* team-scoped var
  // is an opt-out sentinel — it means "this team does not scope on
  // this dimension", not "fall through to the Norton default".
  // Without this, setting `JIRA_AVAST_INCLUDE_BUSINESS_TEAMS=` would
  // still apply Norton's Business Team filter to the AVAST view,
  // filtering out legitimate AVAST tickets. Detecting the opt-out
  // requires `in env` (vs. `undefined`): dotenv loads `KEY=` as "",
  // missing keys are undefined.
  for (const name of teamCandidates) {
    const raw = env[name];
    if (raw === undefined) continue;
    const v = String(raw).trim();
    if (v.length > 0) return { value: v, source: name };
    // Set-but-empty: opt out, don't fall through to globals.
    return { value: "", source: name, optOut: true };
  }

  for (const name of globalCandidates) {
    const raw = env[name];
    if (raw === undefined) continue;
    const v = String(raw).trim();
    if (v.length > 0) return { value: v, source: name };
  }
  const first = teamCandidates[0] ?? globalCandidates[0];
  return { value: "", source: first };
}
