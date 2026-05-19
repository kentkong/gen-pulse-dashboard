#!/usr/bin/env node
/**
 * sanitize-demo.mjs
 *
 * Walks every JSON file under tmp/snapshot-raw/ and produces a fully
 * anonymised copy under dist/data/, ready to ship as static assets
 * to GitHub Pages.
 *
 * What gets scrubbed
 * ==================
 * 1. Real people's names                → fake names from a fixed pool
 *    (deterministic: same real person always gets the same fake)
 * 2. Slack user IDs (U…/W…)             → U_DEMO_<8-hex>
 * 3. Jira issue keys (EMAIL-1234 etc.)  → DEMO-<original number>
 * 4. Email addresses                    → fake.name@example.com
 * 5. Avatar URLs (Slack/Jira/local)     → null  (frontend has a clean
 *                                                 initials-fallback;
 *                                                 not shipping any
 *                                                 real photos in the
 *                                                 public bundle is the
 *                                                 single biggest privacy
 *                                                 win we can ship)
 * 6. Free-text fields (summary, note,
 *    statusText, lastNote, customMessage,
 *    description)                       → curated generic content,
 *                                          deterministically picked by
 *                                          string hash so the demo is
 *                                          stable across runs
 * 7. Corp domains in URLs               → demo.example.com
 * 8. Numbers and aggregate stats        → kept as-is (these are
 *                                          public-shape signals like
 *                                          "team has 26 open tickets",
 *                                          not PII; without them the
 *                                          dashboard is just empty
 *                                          chrome)
 *
 * Determinism
 * -----------
 * Every transform uses a stable string hash (FNV-1a 32-bit) so that
 * re-running the sanitizer produces identical output for identical
 * input. That property matters because:
 *   - the demo data is committed to a public branch; non-determinism
 *     would generate noisy diffs every refresh
 *   - the same person referenced across multiple widgets (leaderboard,
 *     team grid, ticket assignee) needs to remain the same fake person
 *     so the dashboard tells a coherent story
 *
 * Hard rules
 * ----------
 * - This script REFUSES to write to dist/data/ if any file under
 *   tmp/snapshot-raw still contains a known real name after the pass.
 *   That fail-safe means a roster member added later but not yet wired
 *   into the fake-name pool can never accidentally leak through.
 * - Avatar URLs are replaced with null (not anonymised URL); under no
 *   circumstance do we ship URLs pointing at corp infra (Slack edge
 *   CDN, Jira corp host, …) — even with names scrubbed those URLs are
 *   themselves a fingerprint of the org.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { TEAMS } from "../src/team.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(PROJECT_ROOT, "tmp", "snapshot-raw");
const OUT_DIR = path.join(PROJECT_ROOT, "dist", "data");

/* ------------------------------------------------------------------ *
 * Fake name pool.
 *
 * Hand-picked to look plausible without colliding with any well-known
 * real-world figure. Mix of cultural origins so the demo doesn't look
 * monocultural (which a recruiter would notice and ask about).
 *
 * We have 32 first × 32 last = 1024 combinations, so even with hash
 * collisions the dedupe loop in buildNameMap() will find a unique
 * combination for every real person on any plausible roster size.
 * ------------------------------------------------------------------ */
const FAKE_FIRST_NAMES = [
  "Alex", "Jordan", "Sam", "Morgan", "Riley", "Taylor", "Casey", "Jamie",
  "Dana", "Robin", "Avery", "Quinn", "Reese", "Skylar", "Cameron", "Drew",
  "Parker", "Sage", "Rowan", "Ellis", "Blake", "Harper", "Kai", "Logan",
  "Nico", "Remy", "Toby", "Wren", "Hayden", "Marley", "Arden", "Indigo",
];
const FAKE_LAST_NAMES = [
  "Bennett", "Carter", "Davies", "Ellis", "Foster", "Gallagher", "Harper", "Iverson",
  "Jameson", "Klein", "Lambert", "Mercer", "Nash", "Olsen", "Patel", "Quinn",
  "Reyes", "Sinclair", "Tate", "Underwood", "Vargas", "Whitaker", "Xie", "Yates",
  "Zane", "Abara", "Brennan", "Costa", "Dupont", "Eriksen", "Fontaine", "Greco",
];

/* ------------------------------------------------------------------ *
 * Curated content pools.
 *
 * Indexed deterministically off the original string's hash, so the
 * SAME ticket summary across two widgets renders the SAME fake summary
 * (otherwise the demo would feel inconsistent — viewers WILL notice
 * if "DEMO-1234" reads as one thing in the leaderboard and another in
 * the kanban board).
 *
 * Content is deliberately bland and email/marketing/eng flavoured so
 * it matches the dashboard's domain (a portfolio piece for an Email
 * marketing team's engineering ops). Nothing here should reference any
 * specific company, customer, product line, or campaign name.
 * ------------------------------------------------------------------ */
const FAKE_TICKET_SUMMARIES = [
  "Improve unsubscribe flow accessibility",
  "Fix render glitch in Outlook 2019",
  "A/B test for renewal CTA placement",
  "Migrate template to MJML",
  "Investigate iOS Mail preview issue",
  "Optimise campaign queue throughput",
  "Localize French copy for promo banner",
  "Audit GDPR consent footer",
  "Refactor segmentation rule engine",
  "Add metrics for click-through rate",
  "Document email deliverability runbook",
  "Spike: web push as fallback channel",
  "Backfill bounce-suppression list",
  "Hook campaign API into observability stack",
  "Reduce template build time on CI",
  "Patch SPF record drift on staging",
  "Fix dark-mode preview in Litmus",
  "Add structured logging to send pipeline",
  "Investigate flaky e2e suite for templates",
  "Schedule rollout of new footer system",
  "Decompose monolithic targeting query",
  "Standardise UTM params across channels",
  "Move asset pipeline behind CDN edge",
  "Add suppression for unsubscribed cohorts",
  "Reduce noisy Sentry alerts on send",
  "Onboard new locale for transactional emails",
  "Performance budget for hero image renders",
  "Refresh email branding tokens",
  "Validate iCalendar attachments in inbox",
  "Add retry policy for vendor webhooks",
  "Swap deprecated SDK in send-worker",
  "Add canary deploys to email service",
];

const FAKE_NOTES = [
  "Annual leave",
  "Public holiday",
  "Working from home",
  "On call",
  "Heads-down today",
  "Out of office",
  "Conference",
  "Doctor appt",
];

const FAKE_STATUS_TEXTS = [
  "In meetings",
  "Heads-down",
  "On a call",
  "Reviewing PRs",
  "Focusing",
  "Customer call",
  "Out for lunch",
  "Working from home",
];

/* ------------------------------------------------------------------ *
 * Stable string hash (FNV-1a 32-bit).
 *
 * Why not crypto.createHash('sha256')? FNV-1a is plenty for a
 * non-adversarial mapping (we're picking from a 32-element array),
 * it's allocation-free, and using a non-crypto hash makes it loudly
 * obvious to anyone reading this code that the mapping is NOT a
 * security boundary — it's a demo helper. If you ever need to hide
 * real names FROM a determined attacker who has the source, you'd
 * need a salted KDF, not this.
 * ------------------------------------------------------------------ */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function pickFromPool(pool, seed) {
  return pool[fnv1a(seed) % pool.length];
}

/* ------------------------------------------------------------------ *
 * Build the real → fake name mapping from BOTH rosters at once.
 *
 * We do this up front so collisions across rosters are detected and
 * resolved deterministically. If "Daniel Žabenský" (Norton) and
 * "Daniel Smith" (hypothetical Avast) both hashed to the same fake
 * name, the dedupe loop bumps the second one to the next slot. With
 * 1024 pool combinations and at most ~30 real people, we're nowhere
 * near saturation, but the loop is correctness-critical.
 * ------------------------------------------------------------------ */
function buildNameMap() {
  const realPeople = [];
  for (const roster of Object.values(TEAMS)) {
    for (const m of roster) realPeople.push(m);
  }
  // Deterministic sort by slug so the order doesn't depend on which
  // roster was constructed first or on V8 object-key ordering quirks.
  realPeople.sort((a, b) => a.slug.localeCompare(b.slug));

  const map = new Map();
  const used = new Set();
  for (const m of realPeople) {
    let attempt = 0;
    let fake;
    do {
      const seed = `${m.slug}|${attempt}`;
      const first = pickFromPool(FAKE_FIRST_NAMES, `${seed}|first`);
      const last = pickFromPool(FAKE_LAST_NAMES, `${seed}|last`);
      fake = `${first} ${last}`;
      attempt++;
    } while (used.has(fake) && attempt < 50);
    used.add(fake);

    const [fakeFirst, fakeLast] = fake.split(" ");
    const fakeSlug = fake.toLowerCase().replace(/[^a-z]+/g, "-");
    const initials = `${fakeFirst[0]}${fakeLast[0]}`.toUpperCase();

    // Build every variant the live data might use to refer to this
    // person, all pointing at the same fake identity. The live app
    // uses fullName ("Daniel Žabenský"), displayName ("Daniel Ž."),
    // a Jira-style "(CS)" suffix, plus the bare first name — every
    // one of those needs to map cleanly.
    const fakeRecord = {
      fullName: fake,
      displayName: `${fakeFirst} ${fakeLast[0]}.`,
      firstName: fakeFirst,
      lastName: fakeLast,
      slug: fakeSlug,
      initials,
      email: `${fakeFirst}.${fakeLast}@example.com`.toLowerCase(),
      slackId: `U_DEMO_${fnv1a(m.slug).toString(16).toUpperCase().padStart(8, "0")}`,
    };
    map.set(m.slug, fakeRecord);
  }
  return { map, realPeople };
}

/* ------------------------------------------------------------------ *
 * Fast lookup: every realName variant → fake record.
 *
 * Built once, used by replaceNamesInString() to do whole-token swaps
 * without re-walking the roster on every match.
 * ------------------------------------------------------------------ */
function buildNameLookup(nameMap, realPeople) {
  // Each variant of a real name maps to the appropriately-formatted
  // fake string. Critically: "Daniel Žabenský" (full) → "Reese Davies"
  // but "Daniel Ž." (short) → "Reese D." — without that distinction,
  // the Team Presence widget renders the full fake name where the
  // short form is expected, which makes the dashboard look like it
  // accidentally swapped layouts.
  //
  // We also generate the "(CS)" variant on both sides so Jira's
  // CS-account convention is preserved through the sanitization
  // (helps the demo data tell a coherent story about which engineers
  // are in the Customer Success org).
  const byRealName = new Map(); // real string → fake string
  for (const person of realPeople) {
    const fake = nameMap.get(person.slug);
    if (!fake) continue;
    const pairs = [
      [person.fullName, fake.fullName],
      [person.displayName, fake.displayName],
      [`${person.fullName} (CS)`, `${fake.fullName} (CS)`],
      [person.fullName.replace(/\s\(CS\)$/i, ""), fake.fullName],
    ];
    for (const [real, replacement] of pairs) {
      if (real && typeof real === "string") byRealName.set(real, replacement);
    }
  }

  // Slack ID → fake record
  const bySlackId = new Map();
  for (const person of realPeople) {
    const fake = nameMap.get(person.slug);
    if (!fake) continue;
    for (const sid of person.slackIds ?? []) {
      bySlackId.set(sid, fake);
    }
  }

  // Slug → fake record (URL paths use slugs: /team/<slug>.png)
  const bySlug = new Map();
  for (const person of realPeople) {
    const fake = nameMap.get(person.slug);
    if (fake) bySlug.set(person.slug, fake);
  }

  return { byRealName, bySlackId, bySlug };
}

/* ------------------------------------------------------------------ *
 * String-level replacements.
 *
 * Order matters here. We do longest-match-first for names so that
 * "Daniel Žabenský (CS)" doesn't get partially replaced as
 * "<fake-first> <fake-last> (CS)" leaving the bare "Žabenský" intact.
 * ------------------------------------------------------------------ */
function makeStringSanitizer(lookup, realPeople, nameMap) {
  // Sort name variants by length, longest first.
  const nameEntries = [...lookup.byRealName.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  // Pre-compute the email-local-part → fake email map. We do this
  // once, not on every email match, because emailRegex can fire
  // hundreds of times per snapshot pass (Jira ticket descriptions
  // routinely cite reporters' addresses).
  const emailLocalToFake = new Map();
  for (const person of realPeople) {
    const fake = nameMap.get(person.slug);
    if (!fake) continue;
    // Common shapes of corporate email local-parts based on the
    // person's name. We match against any of these substrings.
    const candidates = new Set();
    const full = person.fullName.toLowerCase();
    candidates.add(full.replace(/\s+/g, "."));        // daniel.žabenský
    candidates.add(full.replace(/\s+/g, ""));         // danielžabenský
    const stripped = full.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    candidates.add(stripped.replace(/\s+/g, "."));    // daniel.zabensky
    candidates.add(stripped.replace(/\s+/g, ""));     // danielzabensky
    for (const c of candidates) emailLocalToFake.set(c, fake.email);
  }

  const slackIdRegex = /\b[UW][A-Z0-9]{7,}\b/g;
  // Jira keys: 2+ uppercase letters, dash, digits. EMOPS-1234, EMAILCO-99, etc.
  const jiraKeyRegex = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const corpDomainRegex =
    /https?:\/\/(?:[a-z0-9-]+\.)*(?:nortonlifelock|gendigital|symantec|avast|atlassian)\.(?:com|net|io|cloud|local|corp)\b[^\s"')<>]*/gi;
  const slackEdgeRegex =
    /https?:\/\/(?:[a-z0-9-]+\.)?slack(?:-edge|usercontent)?\.com\b[^\s"')<>]*/gi;

  return function sanitizeString(s) {
    if (typeof s !== "string" || s.length === 0) return s;
    let out = s;

    for (const [real, replacement] of nameEntries) {
      if (out.includes(real)) {
        // Use split/join rather than regex to avoid regex-special
        // chars in real names (diacritics are fine; brackets etc.
        // would be a problem).
        out = out.split(real).join(replacement);
      }
    }

    out = out.replace(slackIdRegex, (id) => {
      const fake = lookup.bySlackId.get(id);
      return fake ? fake.slackId : `U_DEMO_${fnv1a(id).toString(16).toUpperCase().padStart(8, "0")}`;
    });

    out = out.replace(jiraKeyRegex, (key) => {
      const num = key.split("-")[1];
      // Stable per-original-key transform so the same ticket renders
      // as the same DEMO-… id in every widget that mentions it.
      return `DEMO-${num}`;
    });

    out = out.replace(emailRegex, (email) => {
      // If we recognise the local-part as a real teammate (firstname
      // formats like daniel.zabensky@…), map to their fake email.
      const local = email.split("@")[0].toLowerCase();
      const stripped = local.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      for (const [needle, fakeEmail] of emailLocalToFake) {
        if (local === needle || stripped === needle || local.includes(needle) || stripped.includes(needle)) {
          return fakeEmail;
        }
      }
      return `user${(fnv1a(email) % 1000).toString().padStart(3, "0")}@example.com`;
    });

    out = out.replace(corpDomainRegex, (url) => {
      const u = new URL(url, "https://demo.example.com");
      return `https://demo.example.com${u.pathname}`;
    });
    out = out.replace(slackEdgeRegex, () => "https://demo.example.com/avatar-removed");

    return out;
  };
}

/* ------------------------------------------------------------------ *
 * Field-level transforms.
 *
 * For specific known field names we apply curated content rather than
 * trying to clean the original text. Keeps the dashboard looking alive
 * without risking that a long Jira description leaks something we
 * didn't anticipate.
 * ------------------------------------------------------------------ */
const FIELDS_TO_NULL = new Set([
  // Free-form stuff that's safer to nuke than to try to clean.
  "description",
  "comment",
  "comments",
  "statusEmojiUrl", // workspace-custom emoji URLs leak the corp Slack instance
]);

const FIELDS_AS_FAKE_AVATAR = new Set([
  "avatarUrl",
  "avatar_url",
  "avatar",
  "image_72",
  "image_192",
  "image_512",
  "profileUrl", // slack:// URL leaks the workspace ID
]);

// Jira ticket summaries live under `summary` everywhere in this app
// (see widgets/*.js). We deliberately do NOT include `title` here —
// the team-roster object has a `title` = job title field
// ("Sr. Online Marketing Specialist · Email Marketing") that should
// stay intact: job titles aren't PII, and overwriting them with fake
// ticket text makes the demo's Team Presence widget look broken.
const FIELDS_AS_FAKE_SUMMARY = new Set(["summary"]);

const FIELDS_AS_FAKE_NOTE = new Set([
  "note",
  "lastNote",
  "absenceNote",
  "reason",
]);

const FIELDS_AS_FAKE_STATUS_TEXT = new Set([
  "statusText",
  "customMessage",
  "presenceText",
]);

/* ------------------------------------------------------------------ *
 * Recursive walker.
 *
 * A few subtle properties we rely on:
 *  - We always return a NEW object/array; never mutate input.
 *  - Field-level transforms are checked BEFORE recursion. That means
 *    setting "description" to null short-circuits and we don't try to
 *    sanitize whatever was inside it. Important for nested ticket
 *    objects where a description could itself contain user mentions.
 *  - We DO NOT walk into fields whose name suggests they're already
 *    sanitized (e.g. anything starting with "_") so callers can mark
 *    "trust me, this is fine" sub-trees if needed in the future.
 * ------------------------------------------------------------------ */
function walk(node, sanitizeStr) {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") return sanitizeStr(node);
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map((v) => walk(v, sanitizeStr));
  if (typeof node !== "object") return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (FIELDS_TO_NULL.has(k)) {
      out[k] = null;
      continue;
    }
    if (FIELDS_AS_FAKE_AVATAR.has(k)) {
      out[k] = null;
      continue;
    }
    if (FIELDS_AS_FAKE_SUMMARY.has(k) && typeof v === "string" && v.length > 0) {
      out[k] = pickFromPool(FAKE_TICKET_SUMMARIES, v);
      continue;
    }
    if (FIELDS_AS_FAKE_NOTE.has(k) && typeof v === "string" && v.length > 0) {
      out[k] = pickFromPool(FAKE_NOTES, v);
      continue;
    }
    if (FIELDS_AS_FAKE_STATUS_TEXT.has(k) && typeof v === "string" && v.length > 0) {
      out[k] = pickFromPool(FAKE_STATUS_TEXTS, v);
      continue;
    }
    out[k] = walk(v, sanitizeStr);
  }

  // Post-pass: derived fields that depend on a sibling.
  //
  // `initials` is the dangerous one. The live API computes initials
  // from the live name ("DŽ" for Daniel Žabenský) and the value
  // travels through our walker as an opaque 2-character string —
  // none of our string-replacement rules match a 2-char token like
  // "DŽ" (too short for the name lookup, doesn't match the Slack/Jira
  // regexes), so without this fixup the post-sanitize JSON ends up
  // with a fake fullName ("Reese Davies") sitting next to the REAL
  // person's diacritic initials. Fix it by always re-deriving
  // initials from whatever fullName landed in the sanitized output.
  if (typeof out.fullName === "string" && typeof out.initials === "string") {
    const parts = out.fullName.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
    const recomputed = (first + last).toUpperCase();
    if (recomputed) out.initials = recomputed;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Verification pass — refuses to commit a leak.
 *
 * Walks the sanitized output looking for any remaining real-name
 * substring. If found, dumps the offending file:path and exits non-zero.
 * Better to fail the build loudly than to publish a leak.
 * ------------------------------------------------------------------ */
// Operator / admin names that aren't part of the team roster but still
// appear in some mock responses (e.g. preview.js seeds /api/me with
// "Kevin Mold"). Defence in depth: the demo shim synthesises /api/me
// so this is normally harmless, but a future refactor that snapshots
// /api/me wouldn't otherwise be caught by the roster-only check.
const EXTRA_LEAK_NEEDLES = ["Kevin Mold", "kevin.mold", "UDEMOKEV"];

function verifyNoLeaks(node, realPeople, where) {
  // Two pools of needles, with different match rules:
  //   - substring needles: long enough that an accidental substring
  //     match almost certainly indicates a real leak ("zabensky"
  //     appearing inside any string is bad news)
  //   - exact-equal needles: short tokens like initials ("DŽ") that
  //     would false-positive everywhere if treated as substrings,
  //     but where the EXACT value showing up as a whole string in
  //     the output is exactly the leak we want to catch.
  const substringNeedles = [...EXTRA_LEAK_NEEDLES];
  const exactNeedles = [];
  for (const m of realPeople) {
    substringNeedles.push(m.fullName, m.displayName);
    for (const sid of m.slackIds ?? []) substringNeedles.push(sid);
    // Diacritic initials ("DŽ") and stripped initials ("DZ") — these
    // are PII when they're paired with a sanitized fake name (the
    // dashboard would render "Reese Davies (DŽ)" otherwise).
    const parts = m.fullName.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const dia = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      const stripped = dia.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      exactNeedles.push(dia, stripped);
    }
  }
  const normalize = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const subs = substringNeedles.map(normalize).filter((n) => n.length >= 3);
  const exacts = new Set(exactNeedles.map(normalize).filter(Boolean));

  function check(value, path) {
    if (typeof value === "string") {
      const norm = normalize(value);
      if (exacts.has(norm)) {
        return { leaked: norm, at: path, sample: value, kind: "exact" };
      }
      for (const needle of subs) {
        if (norm.includes(needle)) {
          return { leaked: needle, at: path, sample: value.slice(0, 120), kind: "substring" };
        }
      }
      return null;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const r = check(value[i], `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const r = check(v, path ? `${path}.${k}` : k);
        if (r) return r;
      }
    }
    return null;
  }
  return check(node, where);
}

async function listFiles(dir) {
  const out = [];
  async function walkDir(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walkDir(p);
      else if (e.isFile() && p.endsWith(".json")) out.push(p);
    }
  }
  await walkDir(dir);
  return out;
}

async function main() {
  // Refuse to run if there's no snapshot to consume.
  try {
    await fs.access(RAW_DIR);
  } catch {
    console.error(
      `[sanitize] no snapshot found at ${path.relative(PROJECT_ROOT, RAW_DIR)}/.\n` +
        `Run scripts/build-demo-snapshot.mjs first.`
    );
    process.exit(2);
  }

  const { map: nameMap, realPeople } = buildNameMap();
  const lookup = buildNameLookup(nameMap, realPeople);
  const sanitizeString = makeStringSanitizer(lookup, realPeople, nameMap);

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const files = await listFiles(RAW_DIR);
  let processed = 0;
  let leaks = 0;
  for (const file of files) {
    const rel = path.relative(RAW_DIR, file);

    // Don't ship the manifest — it has a real timestamp, real baseUrl
    // (which might be an internal hostname), and a list of failure
    // URLs we don't want in the public bundle.
    if (rel === "manifest.json") continue;

    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const cleaned = walk(raw, sanitizeString);

    const leak = verifyNoLeaks(cleaned, realPeople, rel);
    if (leak) {
      console.error(
        `[sanitize] LEAK in ${rel}: ` +
          `found "${leak.leaked}" at ${leak.at}\n  sample: ${leak.sample}`
      );
      leaks++;
      continue;
    }

    const outFile = path.join(OUT_DIR, rel);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
    processed++;
  }

  // Generate a tiny mapping summary for debugging — this is COMMITTED
  // public output, so it must not contain real names. We log only the
  // fake side and the slug (slug is already public-safe — it's just
  // the kebab-cased fake name).
  const summary = {
    generatedAt: new Date().toISOString(),
    fakeIdentities: realPeople.map((m) => {
      const fake = nameMap.get(m.slug);
      return fake
        ? {
            fakeName: fake.fullName,
            fakeSlug: fake.slug,
            fakeInitials: fake.initials,
            fakeEmail: fake.email,
            fakeSlackId: fake.slackId,
          }
        : null;
    }).filter(Boolean),
    counts: { processed, leaks, totalFiles: files.length },
  };
  await fs.writeFile(
    path.join(OUT_DIR, "_meta.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8"
  );

  console.log(
    `[sanitize] done. processed=${processed} leaks=${leaks} files=${files.length}`
  );
  console.log(`[sanitize] sanitized output → ${path.relative(PROJECT_ROOT, OUT_DIR)}/`);

  if (leaks > 0) {
    console.error(
      `[sanitize] ${leaks} file(s) blocked due to leaks. ` +
        `Add the missing names/IDs to the roster in src/team.js or extend the ` +
        `name lookup in this script, then re-run.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[sanitize] fatal:", err);
  process.exit(99);
});
