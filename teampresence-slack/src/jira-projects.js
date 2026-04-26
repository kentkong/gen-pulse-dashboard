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
 *
 * An empty env var means "no exclusion for this dimension"; the
 * clause is omitted entirely so the JQL stays minimal.
 */
export function applyTeamScope(
  jql,
  env = process.env,
  projectKey,
  { logger = console } = {}
) {
  if (!jql || typeof jql !== "string") return { jql: jql ?? "", applied: [] };

  const assignees = parseCsvScope(
    resolveProjectScalar(env, projectKey, "EXCLUDE_ASSIGNEES").value
  );
  const labels = parseCsvScope(
    resolveProjectScalar(env, projectKey, "EXCLUDE_LABELS").value
  );
  const components = parseCsvScope(
    resolveProjectScalar(env, projectKey, "EXCLUDE_COMPONENTS").value
  );

  if (
    assignees.length === 0 &&
    labels.length === 0 &&
    components.length === 0
  ) {
    return { jql, applied: [] };
  }

  const applied = [];
  const clauses = [`(${jql})`];

  if (assignees.length > 0) {
    const list = assignees.map(jqlQuote).join(", ");
    clauses.push(`(assignee is EMPTY OR assignee not in (${list}))`);
    applied.push({ field: "assignee", values: assignees });
  }
  if (labels.length > 0) {
    const list = labels.map(jqlQuote).join(", ");
    clauses.push(`(labels is EMPTY OR labels not in (${list}))`);
    applied.push({ field: "labels", values: labels });
  }
  if (components.length > 0) {
    const list = components.map(jqlQuote).join(", ");
    clauses.push(`(component is EMPTY OR component not in (${list}))`);
    applied.push({ field: "component", values: components });
  }

  const wrapped = clauses.join(" AND ");
  logger.log?.(
    `[jira] team-scope applied to ${projectKey ?? "default"}: ` +
      applied
        .map((a) => `${a.field}×${a.values.length}`)
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

/** Convenience helper: fetch a scalar non-JQL env var, scoped by project. */
export function resolveProjectScalar(env = process.env, projectKey, suffix) {
  const proj = upperProject(projectKey);
  const candidates = [
    proj && proj !== ALL_PROJECT_KEY.toUpperCase()
      ? `JIRA_${proj}_${suffix}`
      : null,
    proj === ALL_PROJECT_KEY.toUpperCase() ? `JIRA_ALL_${suffix}` : null,
    `JIRA_${suffix}`,
  ].filter(Boolean);
  for (const name of candidates) {
    const v = (env[name] ?? "").trim();
    if (v.length > 0) return { value: v, source: name };
  }
  return { value: "", source: candidates[0] };
}
