/**
 * Workday absence providers.
 *
 * ROLE IN THE SYSTEM
 * ------------------
 *   The aggregator in ./index.js asks whichever provider is
 *   configured (via WORKDAY_PROVIDER) to answer two questions:
 *
 *     1. fetchPresenceForUsers(userIds) → who is out TODAY?
 *     2. listUpcomingAbsences(days)     → who is out in the NEXT N days?
 *
 *   (1) powers the per-member Vacation bucket and source chip.
 *   (2) powers the "Out today" hero strip + "Out next 7 days"
 *       carousel that managers rely on to plan coverage.
 *
 * THE FOUR PROVIDERS
 * ------------------
 *   noop   — default. Inert. Production-safe until Workday is wired.
 *   csv    — reads a locally-maintained CSV. Fastest path to
 *            production-accurate vacations without IT involvement.
 *            See data/workday-absences.example.csv for the schema.
 *   ical   — reads a shared iCal feed (many Workday tenants expose
 *            absences this way, and any calendar URL works). Zero
 *            auth complexity; perfect for an MVP integration.
 *   rest   — reads a JSON endpoint with a documented response shape.
 *            Config-only handoff when IT stands up the real service.
 *
 * ALL FOUR implement the same contract so swapping is a one-line
 * env change. All four are safe to leave running with empty /
 * unreachable config — they degrade to "no data" rather than
 * crashing the dashboard.
 *
 * PRIVACY
 * -------
 *   The absence `type` (Sick / PTO / Personal / ...) is carried
 *   through the payload but the web UI shows "Vacation" to everyone
 *   in the public view, reserving the exact type for the filter
 *   drawer (manager/director view). This is enforced in web.js —
 *   providers themselves just report the truth.
 */

import fs from "node:fs";
import path from "node:path";
import { BUCKETS } from "./mapping.js";
import { findByName } from "../team.js";

/* ------------------------------------------------------------------ *
 * Utilities shared by every provider.
 * ------------------------------------------------------------------ */

function todayYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysFromToday(n, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return todayYmd(d);
}

function overlaps(rangeStart, rangeEnd, start, end) {
  // All dates are YYYY-MM-DD; lexical comparison is date-safe.
  return rangeEnd >= start && rangeStart <= end;
}

/**
 * Normalise any provider's raw row into the shared "absence" shape.
 * Callers can pass slug / email / slackId; matching is attempted in
 * that order of specificity.
 */
function absenceRecord({
  slackId = null,
  email = null,
  slug = null,
  startDate,
  endDate,
  type = "PTO",
  note = "",
}) {
  return {
    slackId: slackId || null,
    email: (email || "").toLowerCase() || null,
    slug: slug || null,
    startDate,
    endDate,
    type: type || "PTO",
    note: note || "",
  };
}

/**
 * Given the full absence list + a target user identifier set,
 * return the absence that is active on `today` (if any).
 * Match priority: slackId > email > slug.
 */
function findActive(absences, { slackId, email, slug }, today) {
  const em = (email || "").toLowerCase();
  return (
    absences.find((a) => {
      const hit =
        (a.slackId && slackId && a.slackId === slackId) ||
        (a.email && em && a.email === em) ||
        (a.slug && slug && a.slug === slug);
      if (!hit) return false;
      return today >= a.startDate && today <= a.endDate;
    }) ?? null
  );
}

/**
 * Common provider wrapper — turns a "give me all absences" loader
 * into the two-method contract the aggregator expects. All
 * providers except `noop` use this.
 */
function buildProviderFromLoader({ kind, loader, logger = console, meta = {} }) {
  const cache = { absences: [], fetchedAt: 0, signature: null };
  const ttlMs = 5 * 60 * 1000; // 5 min cache to avoid hammering source

  async function refreshIfStale() {
    if (cache.signature && Date.now() - cache.fetchedAt < ttlMs) {
      return cache.absences;
    }
    try {
      const { absences, signature } = await loader();
      cache.absences = absences ?? [];
      cache.signature = signature ?? `t=${Date.now()}`;
      cache.fetchedAt = Date.now();
      logger.log?.(
        `[presence:workday-${kind}] loaded ${cache.absences.length} absence rows`
      );
    } catch (err) {
      logger.warn?.(
        `[presence:workday-${kind}] refresh failed: ${err?.message ?? err}`
      );
      // Keep whatever's in the cache — better than going blind.
      cache.fetchedAt = Date.now();
    }
    return cache.absences;
  }

  return {
    kind,
    ...meta,

    async fetchPresenceForUsers(
      userIds,
      { emailByUserId = new Map(), slugByUserId = new Map() } = {}
    ) {
      const absences = await refreshIfStale();
      const today = todayYmd();
      const out = new Map();
      for (const uid of userIds) {
        const match = findActive(
          absences,
          {
            slackId: uid,
            email: emailByUserId.get(uid),
            slug: slugByUserId.get(uid),
          },
          today
        );
        if (match) {
          out.set(uid, {
            bucket: BUCKETS.VACATION,
            reason: `Workday ${match.type} through ${match.endDate}`,
            source: "workday",
            vacationType: match.type,
            through: match.endDate,
            note: match.note,
            updatedAt: Date.now(),
          });
        } else {
          out.set(uid, null);
        }
      }
      return out;
    },

    /**
     * All absences that overlap the window [today, today+days).
     * Returned sorted by startDate asc. Consumed by the "Out today"
     * + "Out next 7 days" UI surfaces.
     */
    async listUpcomingAbsences(days = 7) {
      const absences = await refreshIfStale();
      const today = todayYmd();
      const cutoff = daysFromToday(days);
      return absences
        .filter((a) => overlaps(today, cutoff, a.startDate, a.endDate))
        .sort((a, b) =>
          a.startDate.localeCompare(b.startDate) ||
          a.endDate.localeCompare(b.endDate)
        );
    },
  };
}

/* ================================================================== *
 * noop provider
 * ================================================================== */

export function createNoopWorkdayProvider() {
  return {
    kind: "noop",
    async fetchPresenceForUsers(userIds) {
      const out = new Map();
      for (const uid of userIds) out.set(uid, null);
      return out;
    },
    async listUpcomingAbsences() {
      return [];
    },
  };
}

/* ================================================================== *
 * CSV provider
 *
 * Reads a local absence CSV. Supports matching by slackId, email, or
 * slug (src/team.js). Hot-reloads on file mtime change — ops can
 * add/remove PTOs without restarting the server.
 *
 * See data/workday-absences.example.csv for the documented schema.
 * ================================================================== */

export function createCsvWorkdayProvider({
  csvPath,
  logger = console,
} = {}) {
  if (!csvPath) {
    throw new Error("createCsvWorkdayProvider: csvPath required");
  }

  async function load() {
    let stat;
    try {
      stat = fs.statSync(csvPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        return { absences: [], signature: "missing" };
      }
      throw err;
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const text = fs.readFileSync(csvPath, "utf8");
    const { absences, unmatched } = parseCsvWithDiagnostics(text);
    if (unmatched.length > 0) {
      logger.warn?.(
        `[presence:workday-csv] ${unmatched.length} absence row(s) couldn't be matched ` +
          `to the roster (no slug/email/slackId and the name didn't resolve). ` +
          `Check spelling or add an email column. Unmatched: ` +
          unmatched.map((u) => JSON.stringify(u)).join(", ")
      );
    }
    return { absences, signature };
  }

  return buildProviderFromLoader({
    kind: "csv",
    loader: load,
    logger,
    meta: { csvPath },
  });
}

/**
 * Canonical field → accepted header spellings (all compared after
 * stripping spaces/underscores/hyphens and lower-casing). This is
 * deliberately generous so the CSV parser accepts files exported
 * straight from Workday, Excel, or Google Sheets without the team
 * having to rename columns first.
 */
const HEADER_ALIASES = {
  slug:      ["slug", "handle", "userid", "id"],
  email:     ["email", "emailaddress", "employeeemail", "workemail", "workemailaddress"],
  slackId:   ["slackid", "slack", "slackuserid"],
  name:      ["name", "fullname", "employeename", "employee", "worker", "workername"],
  startDate: ["startdate", "start", "from", "fromdate", "begindate", "begin", "leavestart", "pto start", "ptostart", "startingon"],
  endDate:   ["enddate", "end", "to", "todate", "throughdate", "through", "returndate", "return", "leaveend", "pto end", "ptoend"],
  duration:  ["duration", "days", "hours", "length", "amount"],
  type:      ["type", "absencetype", "leavetype", "timeofftype", "timeoffreason", "category", "reason"],
  note:      ["note", "notes", "comment", "comments", "description", "detail"],
};

const HEADER_LOOKUP = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      m.set(normaliseHeaderKey(alias), canonical);
    }
  }
  return m;
})();

function normaliseHeaderKey(h) {
  return String(h ?? "")
    .toLowerCase()
    .replace(/[\s_\-]+/g, "")
    .replace(/"/g, "")
    .trim();
}

/**
 * Split one CSV line, handling quoted cells (Workday + Excel exports
 * routinely quote values with commas in them like "Žabenský, Daniel").
 */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Map "half day" / "0.5" / "4 hours" → true. A half-day absence is
 * still recorded start==end but flagged via the note so the UI can
 * say "½ day" when it wants to.
 */
function isHalfDayDuration(raw) {
  if (!raw) return false;
  const s = String(raw).trim().toLowerCase();
  if (/half|½|\bhd\b/.test(s)) return true;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return false;
  if (/hour/.test(s) || /\bh\b/.test(s)) return n > 0 && n <= 5;
  return n > 0 && n < 1;
}

/**
 * Thin wrapper that also surfaces *which* rows failed to resolve to a
 * roster member. Helpful the first time a new Workday/HR export
 * format lands — the log immediately names the problem rows so the
 * maintainer can fix a typo or add an `email` column.
 */
export function parseCsvWithDiagnostics(text) {
  const unmatched = [];
  const absences = parseCsv(text, (row) => unmatched.push(row));
  return { absences, unmatched };
}

function parseCsv(text, onUnmatched = null) {
  const lines = text.split(/\r?\n/);
  let headers = null;
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = splitCsvLine(raw);
    if (!headers) {
      headers = cells.map((h) => HEADER_LOOKUP.get(normaliseHeaderKey(h)) ?? null);
      continue;
    }
    const row = {};
    headers.forEach((canonical, i) => {
      if (canonical) row[canonical] = cells[i] ?? "";
    });
    if (!row.startDate || !row.endDate) continue;

    // Resolve the person:
    //   1. Explicit slug / email / slackId win (existing CSV shape).
    //   2. Otherwise try to match `name` against the roster —
    //      necessary for Workday exports which ship "Last, First" or
    //      "First Last" and no slug column.
    let slug = row.slug || null;
    let email = row.email || null;
    const slackId = row.slackId || null;
    if (!slug && !email && !slackId && row.name) {
      const match = findByName(row.name);
      if (match) {
        slug = match.slug;
      } else if (onUnmatched) {
        onUnmatched({
          name: row.name,
          startDate: row.startDate,
          endDate: row.endDate,
        });
      }
    } else if (!slug && !email && !slackId && onUnmatched) {
      onUnmatched({
        startDate: row.startDate,
        endDate: row.endDate,
        reason: "no identifier columns (slug/email/slackId/name)",
      });
    }

    // Half-day support: if duration < 1 (or "half day"), append a
    // marker to the note so the UI can badge it. Start/end remain
    // honest dates.
    let note = row.note || "";
    if (isHalfDayDuration(row.duration)) {
      note = note ? `${note} (½ day)` : "½ day";
    }

    rows.push(
      absenceRecord({
        slackId,
        email,
        slug,
        startDate: row.startDate,
        endDate: row.endDate,
        // Interim HR report omits `type` — fall through to the
        // generic "Time off" default so the UI still renders a
        // Workday chip without claiming a PTO sub-type we don't know.
        type: row.type || "Time off",
        note,
      })
    );
  }
  return rows;
}

/* ================================================================== *
 * iCal provider
 *
 * Reads a public or token-gated .ics feed. Each VEVENT becomes an
 * absence; the aggregator matches attendees to the roster by email
 * (iCal's canonical identifier).
 *
 * SUPPORTED KNOBS
 *   WORKDAY_ICAL_URL        the feed URL
 *   WORKDAY_ICAL_TYPE_MAP   optional: map SUMMARY patterns to types.
 *                           e.g. "Sick=*Sick*, Holiday=*Holiday*, PTO=*"
 *
 * The parser is intentionally minimal — iCal's full spec is a swamp;
 * in practice Workday/Outlook/Google feeds are a well-behaved subset
 * (DTSTART, DTEND, SUMMARY, ATTENDEE, ORGANIZER). We parse VALUE=DATE
 * and DATETIME forms and a single ATTENDEE per VEVENT. If the feed
 * you're pointed at surfaces something weirder, log an issue and
 * we'll extend.
 * ================================================================== */

export function createIcalWorkdayProvider({
  url,
  typeMap = null,
  logger = console,
  // Injected for tests; production uses global fetch.
  fetchImpl = null,
} = {}) {
  if (!url) throw new Error("createIcalWorkdayProvider: url required");
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (!doFetch) {
    throw new Error(
      "createIcalWorkdayProvider: global fetch unavailable (Node < 18?)"
    );
  }

  async function load() {
    const res = await doFetch(url, {
      headers: { Accept: "text/calendar, text/plain;q=0.5, */*;q=0.1" },
    });
    if (!res.ok) {
      throw new Error(`iCal fetch ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const absences = parseIcs(text, { typeMap });
    return { absences, signature: `etag=${res.headers.get("etag") ?? Date.now()}` };
  }

  return buildProviderFromLoader({
    kind: "ical",
    loader: load,
    logger,
    meta: { url },
  });
}

/**
 * Minimal iCal parser. Handles:
 *   - VALUE=DATE (YYYYMMDD) and DATE-TIME (YYYYMMDDTHHMMSSZ) forms
 *   - Line folding (RFC 5545: continuation lines begin with space/tab)
 *   - Case-insensitive property names
 *   - A single ATTENDEE per VEVENT (extracts mailto:email)
 *
 * Anything it can't parse is silently skipped — a malformed VEVENT
 * shouldn't take down the entire feed.
 */
function parseIcs(text, { typeMap = null } = {}) {
  // Unfold continuation lines per RFC 5545 §3.1
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const absences = [];
  let inEvent = false;
  let cur = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }
    if (upper === "END:VEVENT") {
      inEvent = false;
      const built = buildAbsenceFromIcsEvent(cur, typeMap);
      if (built) absences.push(built);
      cur = null;
      continue;
    }
    if (!inEvent || !cur) continue;

    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const nameBits = line.slice(0, sep).split(";");
    const name = nameBits[0].toUpperCase();
    const value = line.slice(sep + 1);

    if (name === "DTSTART") cur.dtstart = value.trim();
    else if (name === "DTEND") cur.dtend = value.trim();
    else if (name === "SUMMARY") cur.summary = value.trim();
    else if (name === "ATTENDEE") {
      const m = value.match(/mailto:([^;>\s]+)/i);
      if (m) cur.email = m[1];
    } else if (name === "ORGANIZER" && !cur.email) {
      const m = value.match(/mailto:([^;>\s]+)/i);
      if (m) cur.email = m[1];
    }
  }
  return absences;
}

function icsDateToYmd(raw) {
  if (!raw) return null;
  // YYYYMMDD or YYYYMMDDTHHMMSSZ
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function buildAbsenceFromIcsEvent(ev, typeMap) {
  if (!ev) return null;
  const start = icsDateToYmd(ev.dtstart);
  let end = icsDateToYmd(ev.dtend);
  if (!start) return null;
  // iCal end dates are EXCLUSIVE for all-day events; we use
  // inclusive. Subtract a day when DTEND looks like a pure date.
  if (end && /^\d{8}$/.test((ev.dtend || "").slice(0, 8)) && end !== start) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    end = d.toISOString().slice(0, 10);
  }
  if (!end) end = start;

  return absenceRecord({
    email: ev.email,
    startDate: start,
    endDate: end,
    type: classifyIcsSummary(ev.summary ?? "", typeMap),
    note: ev.summary ?? "",
  });
}

function classifyIcsSummary(summary, typeMap) {
  // typeMap format (env): "Sick=*Sick*, Holiday=*Holiday*, PTO=*"
  // First matching pattern (from left) wins. If unset, everything is PTO.
  if (!typeMap) return "PTO";
  const lower = summary.toLowerCase();
  for (const { type, pattern } of typeMap) {
    if (pattern === "*") return type;
    const needle = pattern.replace(/\*/g, "").toLowerCase();
    if (lower.includes(needle)) return type;
  }
  return "PTO";
}

/**
 * Parse the env var format "Sick=*Sick*, Holiday=*Holiday*, PTO=*"
 * into an ordered list of { type, pattern }.
 */
export function parseIcalTypeMap(raw) {
  if (!raw) return null;
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [type, pattern] = pair.split("=").map((s) => s.trim());
      return { type: type || "PTO", pattern: pattern || "*" };
    });
}

/* ================================================================== *
 * REST provider
 *
 * Reads a JSON endpoint. Documented response shape (a single GET):
 *
 *   [
 *     {
 *       "employeeEmail": "alice@example.com",  // or "slackId" or "slug"
 *       "startDate":     "2026-04-20",
 *       "endDate":       "2026-04-25",
 *       "type":          "PTO",
 *       "note":          "Spring break"
 *     },
 *     ...
 *   ]
 *
 * Auth:
 *   Bearer token via WORKDAY_TOKEN, optionally overridden per-request
 *   by a custom header set (WORKDAY_REST_HEADERS, JSON string).
 *
 * Pagination:
 *   If the response is an object with `{ results, next }`, the
 *   provider follows `next` until absent. Single-page arrays are
 *   also accepted.
 *
 * This is deliberately opinionated — IT can either conform to this
 * shape (preferred) or we add a transform function to map from
 * their shape. Either is a trivial config change; the bulk of the
 * plumbing is already here.
 * ================================================================== */

export function createRestWorkdayProvider({
  endpoint,
  token = null,
  headers = {},
  transform = null,
  logger = console,
  fetchImpl = null,
} = {}) {
  if (!endpoint) throw new Error("createRestWorkdayProvider: endpoint required");
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function load() {
    const collected = [];
    let url = endpoint;
    let safety = 20; // pagination cap
    let etag = null;

    while (url && safety-- > 0) {
      const h = { Accept: "application/json", ...headers };
      if (token) h.Authorization = `Bearer ${token}`;
      const res = await doFetch(url, { headers: h });
      if (!res.ok) {
        throw new Error(`REST fetch ${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      etag = etag ?? res.headers.get("etag");

      let pageRows;
      let next = null;
      if (Array.isArray(body)) {
        pageRows = body;
      } else if (Array.isArray(body?.results)) {
        pageRows = body.results;
        next = body.next ?? null;
      } else {
        throw new Error("REST response must be an array or {results,next}");
      }
      for (const raw of pageRows) {
        const mapped = transform ? transform(raw) : raw;
        if (!mapped?.startDate || !mapped?.endDate) continue;
        collected.push(
          absenceRecord({
            slackId: mapped.slackId,
            email: mapped.employeeEmail ?? mapped.email,
            slug: mapped.slug,
            startDate: mapped.startDate,
            endDate: mapped.endDate,
            type: mapped.type,
            note: mapped.note,
          })
        );
      }
      url = next;
    }
    return { absences: collected, signature: `etag=${etag ?? Date.now()}` };
  }

  return buildProviderFromLoader({
    kind: "rest",
    loader: load,
    logger,
    meta: { endpoint },
  });
}

/* ================================================================== *
 * Factory: pick a provider from env vars.
 * ================================================================== */

export function workdayProviderFromEnv(env = process.env, logger = console) {
  const kind = (env.WORKDAY_PROVIDER ?? "none").trim().toLowerCase();

  if (kind === "none" || kind === "") {
    return createNoopWorkdayProvider();
  }

  if (kind === "csv") {
    const csvPath = (env.WORKDAY_CSV_PATH ?? "").trim();
    if (!csvPath) {
      logger.warn?.(
        "[presence:workday] WORKDAY_PROVIDER=csv but WORKDAY_CSV_PATH is empty; using noop"
      );
      return createNoopWorkdayProvider();
    }
    return createCsvWorkdayProvider({ csvPath, logger });
  }

  if (kind === "ical") {
    const url = (env.WORKDAY_ICAL_URL ?? "").trim();
    if (!url) {
      logger.warn?.(
        "[presence:workday] WORKDAY_PROVIDER=ical but WORKDAY_ICAL_URL is empty; using noop"
      );
      return createNoopWorkdayProvider();
    }
    const typeMap = parseIcalTypeMap(env.WORKDAY_ICAL_TYPE_MAP);
    return createIcalWorkdayProvider({ url, typeMap, logger });
  }

  if (kind === "rest") {
    const endpoint = (env.WORKDAY_ENDPOINT ?? "").trim();
    const token = (env.WORKDAY_TOKEN ?? "").trim() || null;
    if (!endpoint) {
      logger.warn?.(
        "[presence:workday] WORKDAY_PROVIDER=rest but WORKDAY_ENDPOINT is empty; using noop"
      );
      return createNoopWorkdayProvider();
    }
    let headers = {};
    if (env.WORKDAY_REST_HEADERS) {
      try {
        headers = JSON.parse(env.WORKDAY_REST_HEADERS);
      } catch (err) {
        logger.warn?.(
          `[presence:workday] WORKDAY_REST_HEADERS invalid JSON: ${err.message}`
        );
      }
    }
    return createRestWorkdayProvider({ endpoint, token, headers, logger });
  }

  logger.warn?.(
    `[presence:workday] Unknown WORKDAY_PROVIDER="${kind}" — using noop`
  );
  return createNoopWorkdayProvider();
}
