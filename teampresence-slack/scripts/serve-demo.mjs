#!/usr/bin/env node
/**
 * serve-demo.mjs
 *
 * Tiny zero-dependency static file server for poking at dist/ before
 * pushing it to the public demo branch.
 *
 * GitHub Pages serves files using "just static" semantics — no Jekyll
 * processing (we ship a .nojekyll), no API, just MIME-typed bytes. So
 * a 50-line static server in stdlib is a faithful local mirror.
 *
 * Why we don't just `python -m http.server`: too many devs don't have
 * Python on PATH, and we want this to be one command (`npm run
 * demo:serve`) regardless of host system.
 *
 * Usage:
 *   npm run demo:serve              # http://localhost:4173
 *   PORT=8080 npm run demo:serve    # custom port
 */

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function safeJoin(root, reqPath) {
  // Resolve to an absolute path under DIST_DIR. Anything that
  // escapes (..//etc/passwd) gets rejected.
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const joined = path.normalize(path.join(root, decoded));
  if (!joined.startsWith(root)) return null;
  return joined;
}

const server = http.createServer(async (req, res) => {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end(
      `dist/ doesn't exist yet. Run \`npm run demo:build\` first.\n` +
        `(Looking for: ${DIST_DIR})`
    );
    return;
  }

  let target = safeJoin(DIST_DIR, req.url || "/");
  if (!target) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 forbidden");
    return;
  }

  // If a request lands on a directory, serve index.html from inside it
  // (matches GitHub Pages behaviour).
  try {
    const s = statSync(target);
    if (s.isDirectory()) target = path.join(target, "index.html");
  } catch {
    // path doesn't exist — fall through to the read attempt, which
    // will return a clean 404 below. Some bundles include hashed
    // filenames that won't statSync cleanly because they sit behind
    // a proxy/symlink, so we don't want to error out here.
  }

  try {
    const buf = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`404 — ${path.relative(DIST_DIR, target)} not found`);
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`500 — ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`[demo-serve] http://localhost:${PORT}/`);
  console.log(`[demo-serve] try ?team=avast in the URL to switch teams`);
});
