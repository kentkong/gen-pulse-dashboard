/**
 * demoShare.js
 * ----------------------------------------------------------------
 * Reads the ephemeral Cloudflare quick-tunnel state written by
 * scripts/tunnel-watchdog.sh. That script publishes the current
 * public URL (e.g. https://xyz-abc.trycloudflare.com) into
 * `data/tunnel-state.json` on every tunnel (re)start.
 *
 * This module is the *only* part of the server that knows how to
 * find that file, so swapping the transport later (named tunnel,
 * Tailscale Funnel, corporate ingress) is a one-file change.
 *
 * We re-read the file on every call rather than caching — the
 * tunnel can rotate silently, and the file is tiny. A failed read
 * always returns `{ url: null, status: "down", ... }` so the UI
 * never sees a half-written document.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_PATH = path.join(__dirname, "..", "data", "tunnel-state.json");

/**
 * Load the current tunnel state. Env var `TUNNEL_STATE_FILE` wins over
 * the default, which lets ops point at a centrally-managed location
 * without a code change.
 *
 * Always resolves, never throws. "No file" and "malformed file" both
 * surface as `{ url: null, status: "down" }` — callers treat that as
 * "tunnel isn't up right now, don't show a public URL".
 */
export function readTunnelState(overridePath) {
  const statePath =
    overridePath || (process.env.TUNNEL_STATE_FILE ?? "").trim() || DEFAULT_STATE_PATH;

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    // Defensive normalization — the watchdog is the only writer, but
    // we don't want a typo in that script to break the UI either.
    return {
      url: typeof parsed.url === "string" && /^https?:\/\//.test(parsed.url) ? parsed.url : null,
      localUrl: typeof parsed.localUrl === "string" ? parsed.localUrl : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      status: parsed.status === "up" || parsed.status === "down" ? parsed.status : "down",
      statePath,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        url: null,
        localUrl: null,
        startedAt: null,
        updatedAt: null,
        status: "down",
        statePath,
        reason: "no-state-file",
      };
    }
    return {
      url: null,
      localUrl: null,
      startedAt: null,
      updatedAt: null,
      status: "down",
      statePath,
      reason: "unreadable-state-file",
    };
  }
}

/**
 * Compose the "share this dashboard with a teammate" URL by appending
 * the dashboard shared-key to the current public URL. Returns `null`
 * if either piece is missing, so the UI can degrade gracefully.
 *
 * Deliberate choice: we only ever return this to *authenticated*
 * callers. The shared key is a low-sensitivity secret (read-only
 * access), but it's still a secret — no reason to expose it to
 * anonymous probes.
 */
export function buildShareLinks({ publicUrl, dashboardKey }) {
  if (!publicUrl) {
    return { publicUrl: null, readOnlyUrl: null };
  }
  if (!dashboardKey) {
    return { publicUrl, readOnlyUrl: null };
  }
  try {
    const url = new URL(publicUrl);
    url.searchParams.set("key", dashboardKey);
    return { publicUrl, readOnlyUrl: url.toString() };
  } catch {
    return { publicUrl, readOnlyUrl: null };
  }
}
