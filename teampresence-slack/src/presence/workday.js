/**
 * Workday absence provider.
 *
 * Current status: SCAFFOLDED. The production swap-in is blocked on two
 * answers from the scrum master + IT:
 *
 *   1. Which Workday endpoint is exposed to the CSM team? Options are:
 *      a) Workday REST API (OAuth 2.0, usually via IT-owned service account)
 *      b) Workday RaaS (Reports-as-a-Service) — a signed CSV/JSON report URL
 *      c) Existing shared calendar / iCal feed that already aggregates PTO
 *      d) No direct access → fall back to a manually-maintained CSV in git
 *
 *   2. How are members matched? Workday uses employee IDs; the roster in
 *      src/team.js is keyed by Slack ID + email. We'll need an email
 *      join (easiest) or an explicit workdayId field on each roster entry.
 *
 * Until those answers land, this module exports two provider shapes:
 *
 *   - createNoopWorkdayProvider() — always returns empty. Production-safe.
 *   - createCsvWorkdayProvider({ csvPath }) — reads a CSV of the form
 *       email,startDate,endDate,type
 *       alice@example.com,2026-04-21,2026-04-25,PTO
 *     which can be dropped into the repo as a stopgap while the API
 *     wiring is agreed. SAFE TO USE — no external network calls.
 *
 * When the real endpoint is agreed, add:
 *
 *   - createWorkdayRestProvider({ endpoint, token }) — REST API
 *   - createWorkdayRaasProvider({ reportUrl, auth }) — RaaS report
 *   - createIcalProvider({ icalUrl }) — shared calendar fallback
 *
 * Each must implement the same contract:
 *
 *   async fetchPresenceForUsers(userIds) → Map<userId, {
 *     bucket,       // typically BUCKETS.VACATION when active
 *     reason,       // "Workday PTO through 2026-04-25"
 *     source,       // "workday"
 *     vacationType, // "PTO" | "Sick" | "Holiday" | ...
 *     through,      // ISO date string, end of vacation (inclusive)
 *     updatedAt,
 *   } | null>
 *
 * A `null` result for a user means "no Workday data for today" — the
 * aggregator keeps whatever bucket the Slack provider returned.
 */

import fs from "node:fs";
import path from "node:path";
import { BUCKETS } from "./mapping.js";

/* ------------------------------------------------------------------ *
 * No-op provider — the production default until Workday access lands.
 * ------------------------------------------------------------------ */

export function createNoopWorkdayProvider() {
  return {
    kind: "noop",
    async fetchPresenceForUsers(userIds) {
      const out = new Map();
      for (const uid of userIds) out.set(uid, null);
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * CSV provider — stopgap for manually-maintained absence lists.
 *
 * Expected columns (order-insensitive, case-insensitive):
 *   - slackId OR email   (either is fine; slackId wins when both present)
 *   - startDate          YYYY-MM-DD
 *   - endDate            YYYY-MM-DD (inclusive)
 *   - type               free text; "PTO", "Sick", "Holiday", etc.
 *
 * Lines starting with # are treated as comments. Empty lines ignored.
 *
 * File is re-read every `ttlMs` so ops can update the CSV without
 * restarting the server.
 * ------------------------------------------------------------------ */

export function createCsvWorkdayProvider({
  csvPath,
  ttlMs = 5 * 60 * 1000,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!csvPath) {
    throw new Error("createCsvWorkdayProvider: csvPath required");
  }
  let cache = { rows: [], fetchedAt: 0, signature: null };

  function parseCsv(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return { headers: [], rows: [] };
    const headerLine = lines.find(
      (l) => l.trim().length > 0 && !l.trim().startsWith("#")
    );
    if (!headerLine) return { headers: [], rows: [] };
    const headers = headerLine
      .split(",")
      .map((h) => h.trim().toLowerCase());
    const rows = [];
    let sawHeader = false;
    for (const line of lines) {
      const trim = line.trim();
      if (!trim || trim.startsWith("#")) continue;
      if (!sawHeader) {
        sawHeader = true;
        continue;
      }
      const cells = line.split(",").map((c) => c.trim());
      if (cells.length < headers.length) continue;
      const row = {};
      headers.forEach((h, i) => {
        row[h] = cells[i] ?? "";
      });
      rows.push(row);
    }
    return { headers, rows };
  }

  function refreshIfStale() {
    if (Date.now() - cache.fetchedAt < ttlMs && cache.signature != null) {
      return cache.rows;
    }
    try {
      const stat = fs.statSync(csvPath);
      const sig = `${stat.size}:${stat.mtimeMs}`;
      if (sig === cache.signature) {
        cache.fetchedAt = Date.now();
        return cache.rows;
      }
      const text = fs.readFileSync(csvPath, "utf8");
      const { rows } = parseCsv(text);
      cache = { rows, fetchedAt: Date.now(), signature: sig };
      logger.log?.(
        `[presence:workday-csv] loaded ${rows.length} absence rows from ${path.basename(csvPath)}`
      );
      return rows;
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.warn?.(`[presence:workday-csv] read failed:`, err.message);
      }
      cache = { rows: [], fetchedAt: Date.now(), signature: "missing" };
      return [];
    }
  }

  function todayYmd() {
    const d = now();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  return {
    kind: "csv",
    csvPath,
    async fetchPresenceForUsers(userIds, { emailByUserId = new Map() } = {}) {
      const rows = refreshIfStale();
      const today = todayYmd();
      const out = new Map();
      for (const uid of userIds) {
        const email = emailByUserId.get(uid)?.toLowerCase() ?? null;
        const match = rows.find((r) => {
          const sid = (r.slackid ?? "").trim();
          const rowEmail = (r.email ?? "").trim().toLowerCase();
          const matches =
            (sid && sid === uid) || (email && rowEmail && rowEmail === email);
          if (!matches) return false;
          const start = (r.startdate ?? "").trim();
          const end = (r.enddate ?? "").trim();
          return start && end && today >= start && today <= end;
        });
        if (match) {
          out.set(uid, {
            bucket: BUCKETS.VACATION,
            reason: `Workday ${match.type || "PTO"} through ${match.enddate}`,
            source: "workday",
            vacationType: match.type || "PTO",
            through: match.enddate,
            updatedAt: Date.now(),
          });
        } else {
          out.set(uid, null);
        }
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Factory: pick a provider from env vars.
 *
 * Env:
 *   WORKDAY_PROVIDER = "none" | "csv" | "rest" | "raas" | "ical"
 *   WORKDAY_CSV_PATH = path to an absence CSV (used when provider = csv)
 *   WORKDAY_ENDPOINT / WORKDAY_TOKEN / WORKDAY_REPORT_URL / WORKDAY_ICAL_URL
 *     — reserved for the real providers, not wired in this scaffold yet.
 * ------------------------------------------------------------------ */

export function workdayProviderFromEnv(env = process.env, logger = console) {
  const kind = (env.WORKDAY_PROVIDER ?? "none").trim().toLowerCase();
  if (kind === "none" || kind === "") {
    return createNoopWorkdayProvider();
  }
  if (kind === "csv") {
    const csvPath = (env.WORKDAY_CSV_PATH ?? "").trim();
    if (!csvPath) {
      logger.warn?.(
        "[presence:workday] WORKDAY_PROVIDER=csv but WORKDAY_CSV_PATH is empty; falling back to noop"
      );
      return createNoopWorkdayProvider();
    }
    return createCsvWorkdayProvider({ csvPath, logger });
  }
  // TODO: implement when IT confirms the endpoint shape.
  logger.warn?.(
    `[presence:workday] WORKDAY_PROVIDER="${kind}" is not yet implemented — using noop`
  );
  return createNoopWorkdayProvider();
}
