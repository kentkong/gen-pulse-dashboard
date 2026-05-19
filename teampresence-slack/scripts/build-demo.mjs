#!/usr/bin/env node
/**
 * build-demo.mjs
 *
 * One-shot orchestrator that turns the live Gen Pulse dashboard into a
 * fully self-contained static bundle in dist/, ready to push to a
 * GitHub Pages branch.
 *
 * Steps:
 *   1. (optional) run scripts/build-demo-snapshot.mjs to capture
 *      tmp/snapshot-raw/ from a local server. Skip with --no-snapshot
 *      if you've already captured.
 *   2. Run scripts/sanitize-demo.mjs to anonymise → dist/data/.
 *   3. Render dist/index.html from public/index.html:
 *        - fill the four server-rendered tokens with their static
 *          defaults (TEAM_KEY=norton, BRAND_NAME=Gen Pulse, …)
 *        - inject scripts/demo-shim.js as the very first inline
 *          <script> tag so it patches window.fetch before any of the
 *          page's own boot code can fire a real /api/* call
 *   4. Copy public/img/ → dist/img/  (corporate logos — Norton, Avast,
 *      Gen Pulse — these are public consumer brand assets, fine to
 *      ship).
 *   5. EXPLICITLY do NOT copy public/team/ — those are real Gen
 *      Digital employee photos. The sanitizer already nulls every
 *      avatarUrl in dist/data/, but a belt-and-braces "no real photos
 *      ever land in dist/" rule is the only one we can defend at
 *      review time.
 *   6. Write dist/.nojekyll so GitHub Pages serves the bundle
 *      verbatim (Jekyll's default would silently strip files starting
 *      with `_`, including `_meta.json` produced by the sanitizer).
 *
 * Usage:
 *   node scripts/build-demo.mjs                            # full build
 *   node scripts/build-demo.mjs --no-snapshot              # reuse tmp/snapshot-raw
 *   node scripts/build-demo.mjs --cookie "$GP_SESSION"     # forwarded to snapshot
 *
 * After a successful build, see DEMO.md (Step 4) for how to push
 * dist/ to a `demo` branch on GitHub and enable Pages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const SHIM_PATH = path.join(__dirname, "demo-shim.js");
const SNAPSHOT_SCRIPT = path.join(__dirname, "build-demo-snapshot.mjs");
const SANITIZE_SCRIPT = path.join(__dirname, "sanitize-demo.mjs");
const PREVIEW_SCRIPT = path.join(PROJECT_ROOT, "src", "preview.js");

// --mock uses preview.js, which boots without ANY external dependency
// (no Jira token, no Slack token, no Workday CSV, no Azure AD). It
// already ships hardcoded mock data for every API endpoint the live
// dashboard exposes. We pick a port unlikely to clash with the user's
// own dev server (3000) — 4999 is the demo's quiet corner.
const MOCK_PREVIEW_PORT = 4999;

function parseArgs(argv) {
  const args = {
    mock: false,
    snapshot: true,
    cookie: null,
    key: null,
    baseUrl: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") args.mock = true;
    else if (a === "--no-snapshot") args.snapshot = false;
    else if (a === "--cookie") args.cookie = argv[++i];
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/build-demo.mjs [--mock] [--no-snapshot] " +
          "[--cookie VAL] [--key VAL] [--base-url URL]\n" +
          "\n" +
          "  --mock     Boot src/preview.js (no external deps) and snapshot from it.\n" +
          "             The simplest path: no live server, no cookie, no Jira/Slack tokens.\n" +
          "  default    Snapshot from a live server you've started yourself.\n" +
          "             Requires --cookie or --key.\n"
      );
      process.exit(0);
    }
  }
  return args;
}

function runScript(scriptPath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

/* ------------------------------------------------------------------ *
 * Mock-mode preview server.
 *
 * Spawns src/preview.js as a subprocess on MOCK_PREVIEW_PORT and
 * returns a teardown function once the server is ready. Used by the
 * --mock build flow so users don't have to start the real dashboard
 * (which needs Jira/Slack/Workday tokens) just to refresh the demo
 * bundle.
 *
 * preview.js has no /healthz, but /api/team returns a 200 the moment
 * the HTTP server is listening — that's our readiness probe. We poll
 * with exponential backoff up to ~6 seconds; if it isn't up by then
 * something's wrong with preview.js itself and we should fail loudly.
 * ------------------------------------------------------------------ */
async function startPreviewServer() {
  console.log(`[build] booting preview.js on :${MOCK_PREVIEW_PORT}`);
  const child = spawn(process.execPath, [PREVIEW_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(MOCK_PREVIEW_PORT),
      // Quieter boot — preview.js is chatty by default and would
      // drown out the actual build progress with seed messages.
      BRAND_NAME: process.env.BRAND_NAME ?? "Gen Pulse",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrLines = [];
  child.stderr?.on("data", (d) => stderrLines.push(d.toString()));
  // Drain stdout so the buffer doesn't fill up and stall preview.js;
  // we don't surface its boot logs unless something fails.
  child.stdout?.on("data", () => {});

  // Poll readiness with exponential backoff: 100ms, 200ms, 400ms, …
  // capped at 1s. ~6s total before we give up. /healthz is the
  // cheapest possible probe (no roster lookup, no JSON serialization).
  const probeUrl = `http://127.0.0.1:${MOCK_PREVIEW_PORT}/healthz`;
  const deadline = Date.now() + 6000;
  let delay = 100;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `preview.js exited early (code ${child.exitCode}). Stderr:\n` +
          stderrLines.join("")
      );
    }
    try {
      const res = await fetch(probeUrl);
      if (res.ok) return makeStopper(child);
    } catch {
      // Server not listening yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1000);
  }
  child.kill("SIGTERM");
  throw new Error(
    `preview.js didn't become ready within 6s on port ${MOCK_PREVIEW_PORT}. ` +
      `Try \`node src/preview.js\` manually to see what's happening.`
  );
}

function makeStopper(child) {
  let stopped = false;
  return async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null) return; // already gone
    child.kill("SIGTERM");
    // Give it 500ms to exit gracefully; SIGKILL after that. Otherwise
    // a stuck preview.js process holds the port and the next build
    // run blows up with EADDRINUSE.
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 500);
      child.on("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };
}

/* ------------------------------------------------------------------ *
 * Build dist/index.html.
 *
 * Two transforms in sequence:
 *   1. Replace the server-side template tokens with static defaults.
 *      The tokens are normally filled per-request by web.js based on
 *      ?team=… / cookie state. In static mode there's no per-request
 *      logic, so we ship the Norton variant and let the existing
 *      client-side team switcher swap data-team in the browser.
 *   2. Inject the demo shim as the FIRST script tag inside <head> so
 *      window.fetch is patched before any of the page's own boot
 *      logic can fire a real /api/* request. Putting it after </body>
 *      would be too late — the inline scripts in this page run as
 *      they're parsed.
 * ------------------------------------------------------------------ */
async function buildIndexHtml() {
  const sourceHtml = await fs.readFile(
    path.join(PUBLIC_DIR, "index.html"),
    "utf8"
  );
  const shimSource = await fs.readFile(SHIM_PATH, "utf8");

  const TEMPLATE_TOKENS = {
    "{{BRAND_NAME}}": "Gen Pulse",
    "{{TEAM_KEY}}": "norton",
    "{{BODY_TEAM_ATTR}}": "email-norton",
    "{{TEAM_LABEL}}": "Norton Email",
  };

  let html = sourceHtml;
  for (const [token, value] of Object.entries(TEMPLATE_TOKENS)) {
    html = html.split(token).join(value);
  }

  // Sanity check: if any unfilled `{{…}}` tokens slipped through, the
  // build is wrong — bail loudly rather than ship a half-rendered
  // page.
  const unfilled = html.match(/\{\{[A-Z_]+\}\}/g);
  if (unfilled) {
    throw new Error(
      `dist/index.html still contains unfilled template tokens: ` +
        `${[...new Set(unfilled)].join(", ")}. ` +
        `Add them to TEMPLATE_TOKENS in scripts/build-demo.mjs.`
    );
  }

  // Inject shim as the first <script> after <head>. We wrap it in an
  // explicit IIFE-style guard rather than relying on the shim file's
  // own IIFE, so even if someone pastes raw JS into the shim file
  // without one, it still gets isolated.
  const shimTag =
    `<script id="gp-demo-shim" data-build="${new Date().toISOString()}">\n` +
    `(function(){\n${shimSource}\n})();\n` +
    `</script>\n`;

  const headOpenIdx = html.search(/<head[^>]*>/i);
  if (headOpenIdx === -1) {
    throw new Error("public/index.html has no <head> tag — can't inject shim.");
  }
  const headTagEnd = html.indexOf(">", headOpenIdx) + 1;
  html = html.slice(0, headTagEnd) + "\n" + shimTag + html.slice(headTagEnd);

  // Add a tiny banner noting "demo build" near the title for any
  // savvy viewer who pops the source. Cheap and signals intent.
  html = html.replace(
    /<title>([^<]*)<\/title>/i,
    `<title>$1 · Demo</title>\n  <meta name="x-gen-pulse-demo" content="static-snapshot">`
  );

  return html;
}

/* ------------------------------------------------------------------ *
 * Copy public/img/ → dist/img/.
 *
 * We don't want a recursive copy of `public/` because that would
 * include `team/` (real employee photos). Whitelist `img/` only.
 * ------------------------------------------------------------------ */
async function copyImageAssets() {
  const src = path.join(PUBLIC_DIR, "img");
  const dst = path.join(DIST_DIR, "img");
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    await fs.copyFile(path.join(src, e.name), path.join(dst, e.name));
  }
  return entries.length;
}

/* ------------------------------------------------------------------ *
 * Build dist/gen-pulse-demo.html — the standalone, double-clickable
 * single-file version.
 *
 * Why this exists
 * ---------------
 * Modern browsers block fetch() against file:// origins for security
 * (the rationale: a file:// page reading any sibling file would let
 * a downloaded HTML attachment exfiltrate ~/Documents on click). The
 * server-friendly dist/index.html therefore renders blank widgets
 * when opened by double-clicking from the Finder/Explorer — which is
 * the single most useful UX for "share with a recruiter" or "carry
 * around on a USB stick".
 *
 * The fix: walk dist/data/ at build time, parse every JSON file, and
 * embed them all as a single window.__DEMO_DATA__ global before the
 * shim runs. The shim already knows to prefer the inlined object
 * over fetch (see demo-shim.js), so the rest of the page is
 * untouched.
 *
 * Image handling
 * --------------
 * Logos in dist/img/ are referenced by relative URL ("img/norton-logo.png").
 * Those CAN load from file:// (no fetch involved — the browser does
 * a plain GET as the resource loader, which is allowed). To keep the
 * standalone file truly single-file, we base64-encode them as data:
 * URIs and inline. Costs ~50% size overhead per image; small price for
 * a self-contained portfolio artefact.
 * ------------------------------------------------------------------ */
async function buildStandaloneHtml() {
  // 1. Walk dist/data/ and build the inline data blob.
  const dataDir = path.join(DIST_DIR, "data");
  const dataBlob = {};
  async function gatherJson(dir, prefix = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const key = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await gatherJson(p, key);
      } else if (e.isFile() && p.endsWith(".json")) {
        // Key shape matches what demo-shim.js looks up: shim derives
        // `mapped.path = "./data/<team>/<rest>.json"`, then strips the
        // "./data/" prefix and indexes into __DEMO_DATA__. So the
        // file at dist/data/norton/team.json must be stored under
        // the key "norton/team.json" — exactly what the recursive
        // walker produces here.
        const raw = await fs.readFile(p, "utf8");
        try {
          dataBlob[key] = JSON.parse(raw);
        } catch (err) {
          throw new Error(`bad JSON at ${p}: ${err.message}`);
        }
      }
    }
  }
  await gatherJson(dataDir);

  // 2. Read the server-friendly bundle. We re-derive everything from
  // dist/index.html so the standalone build inherits any future
  // changes to the shim or template tokens automatically.
  let html = await fs.readFile(path.join(DIST_DIR, "index.html"), "utf8");

  // 3. Inline the logo images. Without this, double-clicking the
  // standalone HTML works but the hero banner shows broken-image
  // icons because the `<img src="img/norton-logo.png">` references
  // are resolved against a non-existent sibling on the user's disk.
  const imgDir = path.join(DIST_DIR, "img");
  const imgEntries = await fs.readdir(imgDir).catch(() => []);
  for (const name of imgEntries) {
    const p = path.join(imgDir, name);
    const buf = await fs.readFile(p);
    const ext = path.extname(name).toLowerCase().slice(1);
    const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    // Replace `img/<name>`, `./img/<name>`, `/img/<name>` references.
    const patterns = [
      new RegExp(`(["'(])\\.?/?img/${name.replace(/[.+]/g, "\\$&")}`, "g"),
    ];
    for (const re of patterns) {
      html = html.replace(re, `$1${dataUri}`);
    }
  }

  // 4. Inject window.__DEMO_DATA__ as the FIRST script in <head>,
  // before the existing shim. Stringify with no pretty-printing —
  // saves ~30% size and the browser doesn't care.
  const dataScript =
    `<script id="gp-demo-data">window.__DEMO_DATA__ = ` +
    JSON.stringify(dataBlob).replace(/<\/script/gi, "<\\/script") +
    `;</script>\n`;

  const headOpenIdx = html.search(/<head[^>]*>/i);
  const headTagEnd = html.indexOf(">", headOpenIdx) + 1;
  html = html.slice(0, headTagEnd) + "\n" + dataScript + html.slice(headTagEnd);

  // 5. Add a tiny offline-mode notice to the title for clarity.
  html = html.replace(
    /<title>([^<]*)<\/title>/i,
    `<title>$1 · Standalone</title>`
  );

  const outPath = path.join(DIST_DIR, "gen-pulse-demo.html");
  await fs.writeFile(outPath, html, "utf8");
  return {
    path: outPath,
    sizeKb: (html.length / 1024).toFixed(0),
    blobKeys: Object.keys(dataBlob).length,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`[build] project root: ${PROJECT_ROOT}`);

  let stopPreview = null;
  try {
    if (args.mock) {
      // Easy path: boot preview.js, snapshot from it, kill it.
      // No live server, no cookie, no Jira/Slack tokens needed.
      stopPreview = await startPreviewServer();
      console.log(`\n[build] step 1/4 — snapshot mock server`);
      await runScript(SNAPSHOT_SCRIPT, [
        "--base-url",
        `http://127.0.0.1:${MOCK_PREVIEW_PORT}`,
        // preview.js doesn't enforce auth, but the snapshot script
        // refuses to run without --cookie or --key. Pass a throwaway
        // key — preview.js ignores it and we satisfy the script's
        // "you forgot to authenticate" guard.
        "--key",
        "mock-not-checked",
      ]);
    } else if (args.snapshot) {
      console.log(`\n[build] step 1/4 — snapshot live server`);
      const snapArgs = [];
      if (args.cookie) snapArgs.push("--cookie", args.cookie);
      if (args.key) snapArgs.push("--key", args.key);
      if (args.baseUrl) snapArgs.push("--base-url", args.baseUrl);
      await runScript(SNAPSHOT_SCRIPT, snapArgs);
    } else {
      console.log(`\n[build] step 1/4 — SKIPPED (--no-snapshot)`);
    }
  } finally {
    if (stopPreview) {
      console.log(`[build] stopping preview.js`);
      await stopPreview();
    }
  }

  console.log(`\n[build] step 2/4 — sanitize`);
  await runScript(SANITIZE_SCRIPT);

  console.log(`\n[build] step 3/4 — render dist/index.html + copy assets`);
  await fs.mkdir(DIST_DIR, { recursive: true });
  const html = await buildIndexHtml();
  await fs.writeFile(path.join(DIST_DIR, "index.html"), html, "utf8");

  const imgCount = await copyImageAssets();
  console.log(`  ✓ index.html (${(html.length / 1024).toFixed(1)} kB)`);
  console.log(`  ✓ img/ (${imgCount} files)`);

  // The standalone single-file build. Anyone can double-click this
  // from the Finder and it works — no terminal, no server, no GitHub.
  const standalone = await buildStandaloneHtml();
  console.log(
    `  ✓ gen-pulse-demo.html  (${standalone.sizeKb} kB, ${standalone.blobKeys} JSON blobs inlined)`
  );

  // .nojekyll: GitHub Pages otherwise treats this as a Jekyll site
  // and silently drops files starting with `_` (e.g. _meta.json,
  // generated by the sanitizer). One byte to prevent a confusing
  // "why is _meta.json missing on production but present locally?"
  // bug report from your future self.
  await fs.writeFile(path.join(DIST_DIR, ".nojekyll"), "", "utf8");

  // README explaining what this branch is, in case anyone (or future
  // you) clones the demo branch and wonders.
  const readme =
    `# Gen Pulse — Demo Build\n\n` +
    `This branch is **machine-generated**. Do NOT edit files here by hand.\n\n` +
    `It contains a fully static, sanitized snapshot of the live Gen Pulse\n` +
    `dashboard suitable for portfolio display on GitHub Pages.\n\n` +
    `Source repo (private): https://github.com/kentkong/gen-pulse-dashboard\n\n` +
    `## How it was built\n\n` +
    `\`\`\`bash\n` +
    `npm run build:demo\n` +
    `# → dist/ contains the bundle pushed to this branch\n` +
    `\`\`\`\n\n` +
    `See \`DEMO.md\` on the main branch for the full workflow.\n\n` +
    `## Sanitization guarantees\n\n` +
    `- All employee names replaced with deterministically-generated fakes\n` +
    `- All Slack user IDs replaced with \`U_DEMO_*\`\n` +
    `- All Jira issue keys replaced with \`DEMO-*\`\n` +
    `- All employee photos excluded from the bundle\n` +
    `- All private corporate hostnames in URLs replaced with \`demo.example.com\`\n` +
    `- Build refuses to publish if any real name leaks through\n`;
  await fs.writeFile(path.join(DIST_DIR, "README.md"), readme, "utf8");

  console.log(`\n[build] step 4/4 — verify`);

  // Sanity check: make sure dist/ doesn't accidentally contain any
  // real-photo binaries from public/team/. Belt-and-braces — the
  // copy logic above only copies public/img/, but a future change
  // could break that without a test catching it.
  const teamPhotoDir = path.join(DIST_DIR, "team");
  try {
    await fs.access(teamPhotoDir);
    throw new Error(
      `dist/team/ exists — real employee photos may have leaked into the bundle. ` +
        `Inspect ${teamPhotoDir} and remove before pushing.`
    );
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // expected: dist/team/ should not exist
  }
  console.log(`  ✓ dist/team/ absent — no employee photos in bundle`);

  // Final checklist for the user.
  console.log(
    `\n[build] done. dist/ is ready to push.\n\n` +
      `Next: see DEMO.md for the deploy step. TL;DR:\n` +
      `  git worktree add ../gen-pulse-demo demo\n` +
      `  cp -R dist/. ../gen-pulse-demo/\n` +
      `  cd ../gen-pulse-demo && git add -A && git commit -m "demo build"\n` +
      `  git push origin demo\n` +
      `Then enable GitHub Pages on the 'demo' branch in repo settings.`
  );
}

main().catch((err) => {
  console.error("\n[build] failed:", err.message ?? err);
  process.exit(1);
});
