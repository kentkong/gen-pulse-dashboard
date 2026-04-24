/**
 * Azure AD OIDC flow helpers.
 *
 * This module owns the **transport** side of SSO — initial discovery,
 * building the authorize URL with PKCE, exchanging the callback code
 * for tokens, and issuing signed session cookies. The per-request
 * "who is this?" question is answered by src/auth.js using the
 * session cookie we set here (so that every hot path is a cheap
 * HMAC check, not a network call).
 *
 * Contract with the rest of the app:
 *
 *   const oidc = await initOidcFromEnv(process.env);
 *   if (oidc.ready) {
 *     // wire /auth/login, /auth/callback, /auth/logout in web.js
 *   } else {
 *     // boot with shared-key only; the one-line reason is in oidc.reason
 *   }
 *
 * We NEVER crash the server if OIDC is misconfigured. That would be a
 * terrible property for an ops team: a typo in the tenant id should
 * not take down the dashboard. Instead we log loudly and fall through
 * to shared-key auth.
 */

import crypto from "node:crypto";
import {
  discovery,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  randomPKCECodeVerifier,
  randomState,
  randomNonce,
  authorizationCodeGrant,
} from "openid-client";

/* ------------------------------------------------------------------ *
 * Cookie plumbing
 *
 * We avoid cookie-parser / express-session entirely — they're heavy,
 * they've had CVEs, and the footprint we need is trivially expressible
 * in Node's built-in crypto. Keeping this tight also makes the
 * security surface easy to audit.
 * ------------------------------------------------------------------ */

/** Parse the "cookie" request header into a plain object. */
export function parseCookies(req) {
  const header = req?.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Sign a JSON payload into a compact `<b64url-payload>.<b64url-hmac>`
 * cookie value. We roll our own minimal JWS-equivalent (HS256 over an
 * untyped payload) so we don't pay the dependency cost of `jsonwebtoken`.
 *
 * Payload MUST include an `exp` field (seconds since epoch). We
 * enforce this at verify time so forgetting to set it can't produce a
 * never-expiring session token.
 */
export function signPayload(payload, secret) {
  if (!secret) throw new Error("signPayload: empty secret");
  if (typeof payload.exp !== "number") {
    throw new Error("signPayload: payload must set numeric `exp` (unix seconds)");
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Verify + decode a token produced by signPayload. Returns the
 * payload on success, `null` on any failure (tampered, expired,
 * malformed, wrong secret). Never throws.
 */
export function verifyPayload(token, secret) {
  if (!token || !secret || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  // timingSafeEqual refuses unequal-length inputs; bail first.
  if (expected.length !== mac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number") return null;
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** Serialize a Set-Cookie header value. */
export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.path) bits.push(`Path=${opts.path}`);
  if (opts.domain) bits.push(`Domain=${opts.domain}`);
  if (opts.secure) bits.push("Secure");
  if (opts.httpOnly) bits.push("HttpOnly");
  if (opts.sameSite) bits.push(`SameSite=${opts.sameSite}`);
  return bits.join("; ");
}

/* ------------------------------------------------------------------ *
 * OIDC configuration + discovery
 * ------------------------------------------------------------------ */

/**
 * Role mapping. Azure returns groups as a list of GUID strings in the
 * `groups` claim. We let admins pin env vars of the form
 * `OIDC_ROLE_MAP_<anything>=<guid>=<role-name>` and produce a flat
 * `Map<guid, roleName>`. Multiple GUIDs can map to the same role.
 *
 * Example:
 *   OIDC_ROLE_MAP_CSM_TEAM=11111111-2222-3333-4444-555555555555=member
 *   OIDC_ROLE_MAP_CSM_MGMT=66666666-7777-8888-9999-aaaaaaaaaaaa=manager
 *   OIDC_ROLE_MAP_ADMINS  =bbbbbbbb-cccc-dddd-eeee-ffffffffffff=admin
 */
export function parseRoleMap(env) {
  const out = new Map();
  for (const [k, raw] of Object.entries(env)) {
    if (!/^OIDC_ROLE_MAP(_|$)/i.test(k)) continue;
    if (typeof raw !== "string" || !raw.includes("=")) continue;
    const eq = raw.indexOf("=");
    const guid = raw.slice(0, eq).trim();
    const role = raw.slice(eq + 1).trim();
    if (!guid || !role) continue;
    out.set(guid.toLowerCase(), role);
  }
  return out;
}

export function rolesFromGroups(groups, roleMap) {
  if (!Array.isArray(groups) || !roleMap?.size) return [];
  const seen = new Set();
  for (const g of groups) {
    const r = roleMap.get(String(g).toLowerCase());
    if (r) seen.add(r);
  }
  return Array.from(seen);
}

/**
 * Initialise an OIDC client from env vars. Safe to call even when
 * nothing is configured — returns `{ ready: false, reason }` so the
 * caller can decide what to do (almost always: boot anyway, use
 * shared-key, print a hint).
 */
export async function initOidcFromEnv(env = process.env) {
  const strategy = (env.AUTH_STRATEGY ?? "").trim().toLowerCase();
  if (strategy === "mock-oidc") {
    return initMockOidcFromEnv(env);
  }
  if (strategy !== "oidc") {
    return { ready: false, reason: `AUTH_STRATEGY=${strategy || "(unset)"} — OIDC disabled` };
  }

  const tenantId = (env.OIDC_TENANT_ID ?? "").trim();
  const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (env.OIDC_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.OIDC_REDIRECT_URI ?? "").trim();
  const sessionSecret = (env.OIDC_SESSION_SECRET ?? "").trim();

  const missing = [];
  if (!tenantId) missing.push("OIDC_TENANT_ID");
  if (!clientId) missing.push("OIDC_CLIENT_ID");
  if (!clientSecret) missing.push("OIDC_CLIENT_SECRET");
  if (!redirectUri) missing.push("OIDC_REDIRECT_URI");
  if (!sessionSecret) missing.push("OIDC_SESSION_SECRET");
  if (missing.length) {
    return {
      ready: false,
      reason: `OIDC requested but missing env: ${missing.join(", ")}`,
    };
  }
  if (sessionSecret.length < 32) {
    return {
      ready: false,
      reason:
        "OIDC_SESSION_SECRET must be >=32 chars (`openssl rand -hex 32` is a good default)",
    };
  }

  const issuerUrl = new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
  let config;
  try {
    config = await discovery(issuerUrl, clientId, clientSecret);
  } catch (err) {
    return {
      ready: false,
      reason: `OIDC discovery failed for ${issuerUrl.href}: ${err?.message ?? err}`,
    };
  }

  const roleMap = parseRoleMap(env);
  const sessionTtlMinutes = Number(env.OIDC_SESSION_TTL_MINUTES ?? 480); // 8h
  const sessionCookieName = (env.OIDC_SESSION_COOKIE ?? "gp_session").trim();
  const allowSharedKeyFallback =
    String(env.OIDC_ALLOW_SHARED_KEY_FALLBACK ?? "").toLowerCase() === "true";
  // For local dev the redirect URI is http://localhost:..., which means
  // Secure cookies would be stripped. Auto-detect from the redirect URI
  // scheme so admins don't have to remember another knob.
  const secureCookies = redirectUri.startsWith("https://");

  return {
    ready: true,
    config,
    clientId,
    redirectUri,
    sessionSecret,
    sessionCookieName,
    sessionTtlSeconds: Math.max(60, Math.floor(sessionTtlMinutes * 60)),
    roleMap,
    allowSharedKeyFallback,
    secureCookies,
    issuerUrl: issuerUrl.href,
  };
}

/* ------------------------------------------------------------------ *
 * Mock OIDC (AUTH_STRATEGY=mock-oidc)
 *
 * Rationale: before Azure AD app registration is approved (RITM0213874
 * at time of writing), we still need to exercise the full signed-in
 * UI end-to-end — user chip, avatar, role chips, /api/me shape, the
 * banner/badge affordances. A separate "demo" auth mode means we can
 * demo Gen Pulse in "what a signed-in manager sees" state without
 * being blocked on IT.
 *
 * The mock mode produces the EXACT same session-cookie format as
 * real OIDC (same signPayload / verifyPayload, same cookie name,
 * same shape in /api/me) — the only thing it skips is the Azure
 * round-trip. This guarantees that flipping AUTH_STRATEGY from
 * mock-oidc → oidc is a pure env-var swap: no UI changes needed.
 *
 * Security posture: mock mode MUST NEVER be enabled in production.
 * We guard it two ways:
 *   1. OIDC_MOCK_ALLOW=true must be set (explicit opt-in).
 *   2. A loud console warning on boot that includes the pid.
 * ------------------------------------------------------------------ */

function initMockOidcFromEnv(env) {
  const allow = String(env.OIDC_MOCK_ALLOW ?? "").toLowerCase() === "true";
  if (!allow) {
    return {
      ready: false,
      reason:
        "AUTH_STRATEGY=mock-oidc requires OIDC_MOCK_ALLOW=true — this mode bypasses Azure and must be enabled explicitly.",
    };
  }

  const sessionSecret = (env.OIDC_SESSION_SECRET ?? "").trim();
  if (!sessionSecret) {
    return {
      ready: false,
      reason:
        "AUTH_STRATEGY=mock-oidc needs OIDC_SESSION_SECRET (>=32 chars). Run `openssl rand -hex 32` and paste the output.",
    };
  }
  if (sessionSecret.length < 32) {
    return {
      ready: false,
      reason:
        "OIDC_SESSION_SECRET must be >=32 chars (`openssl rand -hex 32` is a good default)",
    };
  }

  const port = String(env.PORT ?? "3000").trim();
  const redirectUri = (env.OIDC_REDIRECT_URI ?? `http://localhost:${port}/auth/callback`).trim();
  const sessionTtlMinutes = Number(env.OIDC_SESSION_TTL_MINUTES ?? 480);
  const sessionCookieName = (env.OIDC_SESSION_COOKIE ?? "gp_session").trim();
  const allowSharedKeyFallback =
    String(env.OIDC_ALLOW_SHARED_KEY_FALLBACK ?? "").toLowerCase() === "true";

  // Prefill values for the login form — lets a demo rehearsal be a
  // single click ("Sign in as Kevin Mold (manager)") instead of typing.
  const mockDefaults = {
    displayName: (env.OIDC_MOCK_DEFAULT_NAME ?? "Kevin Mold").trim(),
    email: (env.OIDC_MOCK_DEFAULT_EMAIL ?? "kevin.mold@gendigital.com").trim(),
    roles: (env.OIDC_MOCK_DEFAULT_ROLES ?? "manager")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };

  console.warn(
    `[auth] ⚠ MOCK OIDC ENABLED (AUTH_STRATEGY=mock-oidc, pid=${process.pid}). ` +
      `This bypasses Azure AD — do NOT enable in production. Default identity: ` +
      `${mockDefaults.displayName} <${mockDefaults.email}> roles=[${mockDefaults.roles.join(",")}]`
  );

  return {
    ready: true,
    mock: true,
    clientId: "mock-oidc-demo",
    redirectUri,
    sessionSecret,
    sessionCookieName,
    sessionTtlSeconds: Math.max(60, Math.floor(sessionTtlMinutes * 60)),
    roleMap: new Map(),
    allowSharedKeyFallback,
    secureCookies: redirectUri.startsWith("https://"),
    issuerUrl: "mock://gen-pulse-demo/",
    mockDefaults,
  };
}

/**
 * Read a urlencoded or JSON request body into a plain object. Used by
 * the mock login POST handler. We avoid adding body-parser middleware
 * (same reason we avoid cookie-parser) — the surface we need is small
 * enough to hand-roll without risking a CVE-adjacent dep.
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    // Slack Bolt's ExpressReceiver registers urlencoded/json globally,
    // so in almost all cases req.body is already parsed. Short-circuit
    // when that's true so we don't await the stream a second time.
    if (req.body && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    const chunks = [];
    let total = 0;
    const MAX = 1024 * 16; // 16KB is comically generous for a login form
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      const ct = (req.headers?.["content-type"] ?? "").toLowerCase();
      if (ct.includes("application/json")) {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
        return;
      }
      // Default: urlencoded. Same-name keys (e.g. a multi-select
      // `<input type=checkbox name="roles">` block) must fold into an
      // array — otherwise the POST loses every value but the last.
      const out = {};
      for (const part of raw.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const rawK = eq < 0 ? part : part.slice(0, eq);
        const rawV = eq < 0 ? "" : part.slice(eq + 1);
        const k = decodeURIComponent(rawK.replace(/\+/g, " "));
        const v = decodeURIComponent(rawV.replace(/\+/g, " "));
        if (Object.prototype.hasOwnProperty.call(out, k)) {
          const existing = out[k];
          out[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
        } else {
          out[k] = v;
        }
      }
      resolve(out);
    });
    req.on("error", reject);
  });
}

function sanitizeReturnTo(raw) {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function renderMockLoginForm(oidc, req, res) {
  const returnTo = sanitizeReturnTo(req.query?.return_to ?? "/");
  const { displayName, email, roles } = oidc.mockDefaults ?? {
    displayName: "",
    email: "",
    roles: [],
  };
  const rolesValue = roles.join(", ");
  // Minimal, self-contained, inline styles — no external CSS or JS.
  // Matches the "Gen Pulse" visual language (Gen blue, rounded pill
  // button, soft card) without pulling anything from the app.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gen Pulse — Demo sign-in</title>
<style>
  :root {
    --bg: #f7f7fb;
    --card: #ffffff;
    --ink: #12111c;
    --muted: #5a5a6d;
    --border: #e5e5ef;
    --gen-blue: #0400f5;
    --gen-purple: #5a00ba;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 2rem 1rem; }
  .card { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 2rem 2rem 1.75rem; box-shadow: 0 20px 50px -30px rgba(16,18,46,0.25); }
  .brand { display: flex; align-items: center; gap: 0.55rem; margin-bottom: 1.1rem; font-weight: 700; font-size: 0.95rem; letter-spacing: 0.01em; }
  .gen-logo { display: inline-flex; align-items: center; justify-content: center; width: 1.8rem; height: 1.8rem; border-radius: 6px; background: linear-gradient(135deg, var(--gen-blue), var(--gen-purple)); color: #fff; font-weight: 700; font-size: 0.75rem; letter-spacing: 0.02em; }
  .crumb { color: var(--muted); font-weight: 500; }
  h1 { font-size: 1.3rem; margin: 0.25rem 0 0.35rem; }
  .lede { color: var(--muted); margin: 0 0 1.4rem; font-size: 0.92rem; }
  .warn { display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.6rem 0.75rem; border-radius: 8px; background: #fff8e1; border: 1px solid #facc15; color: #713f12; font-size: 0.82rem; margin-bottom: 1.2rem; }
  .warn strong { display: block; margin-bottom: 0.1rem; }
  label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0.85rem 0 0.3rem; }
  input[type=text], input[type=email] { width: 100%; padding: 0.6rem 0.75rem; border-radius: 8px; border: 1px solid var(--border); font: inherit; color: inherit; background: #fff; }
  input:focus { outline: 2px solid color-mix(in srgb, var(--gen-blue) 45%, transparent); outline-offset: 1px; border-color: var(--gen-blue); }
  .roles { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.3rem; }
  .role-chip { border: 1px solid var(--border); background: #fff; padding: 0.35rem 0.7rem; border-radius: 999px; font-size: 0.8rem; cursor: pointer; user-select: none; }
  .role-chip input { position: absolute; opacity: 0; pointer-events: none; }
  .role-chip:has(input:checked) { border-color: var(--gen-blue); background: color-mix(in srgb, var(--gen-blue) 8%, transparent); color: var(--gen-blue); font-weight: 600; }
  .actions { display: flex; align-items: center; gap: 0.75rem; margin-top: 1.4rem; }
  button.primary { flex: 1; padding: 0.7rem 1rem; background: linear-gradient(135deg, var(--gen-blue), var(--gen-purple)); color: #fff; border: 0; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; }
  button.primary:hover { filter: brightness(1.05); }
  a.cancel { color: var(--muted); text-decoration: none; font-size: 0.88rem; }
  a.cancel:hover { color: var(--ink); }
  .ms-logo { display: inline-grid; grid-template-columns: repeat(2, 0.5rem); grid-template-rows: repeat(2, 0.5rem); gap: 2px; vertical-align: -2px; margin-right: 0.4rem; }
  .ms-logo span { display: block; }
  footer { margin-top: 1rem; color: var(--muted); font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="POST" action="/auth/login">
      <div class="brand">
        <span class="gen-logo">Gen</span>
        <span>Gen Pulse</span>
        <span class="crumb">› Demo sign-in</span>
      </div>
      <h1>Sign in as a test user</h1>
      <p class="lede">Azure AD app registration is in flight (<code>RITM0213874</code>). Until it clears, this mock sign-in issues the same session cookie format as real SSO so the dashboard can be demo&rsquo;d end-to-end.</p>
      <div class="warn">
        <span aria-hidden="true">⚠</span>
        <span>
          <strong>Mock mode is active</strong>
          No Azure round-trip. This page is only available when <code>AUTH_STRATEGY=mock-oidc</code> + <code>OIDC_MOCK_ALLOW=true</code>.
        </span>
      </div>

      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />

      <label for="displayName">Display name</label>
      <input type="text" id="displayName" name="displayName" value="${escapeHtml(displayName)}" autocomplete="off" required />

      <label for="email">Email</label>
      <input type="email" id="email" name="email" value="${escapeHtml(email)}" autocomplete="off" required />

      <label>Roles (for widget permissions)</label>
      <div class="roles">
        ${["member", "manager", "director", "admin"]
          .map(
            (r) =>
              `<label class="role-chip"><input type="checkbox" name="roles" value="${r}"${
                roles.includes(r) ? " checked" : ""
              } />${r}</label>`
          )
          .join("")}
      </div>

      <div class="actions">
        <button type="submit" class="primary">
          <span class="ms-logo" aria-hidden="true">
            <span style="background:#F25022"></span><span style="background:#7FBA00"></span><span style="background:#00A4EF"></span><span style="background:#FFB900"></span>
          </span>
          Sign in (mock SSO)
        </button>
        <a class="cancel" href="${escapeHtml(returnTo)}">Cancel</a>
      </div>

      <footer>Returns you to <code>${escapeHtml(returnTo)}</code> after sign-in.</footer>
    </form>
  </div>
</body>
</html>`;
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

export async function completeMockLogin(oidc, req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain");
    res.end(`Could not read login form: ${err?.message ?? err}`);
    return;
  }

  const displayName = String(body.displayName ?? "").trim() || "Demo User";
  const email = String(body.email ?? "").trim() || "demo@gen-pulse.invalid";
  // Checkboxes come through as either a single string or (if the web
  // framework groups same-named fields) an array.
  let roles = [];
  if (Array.isArray(body.roles)) {
    roles = body.roles.map(String);
  } else if (typeof body.roles === "string" && body.roles.length) {
    roles = [body.roles];
  }
  roles = Array.from(new Set(roles.map((r) => r.trim()).filter(Boolean)));

  const returnTo = sanitizeReturnTo(body.return_to ?? "/");
  const now = Math.floor(Date.now() / 1000);

  // Deterministic-but-per-identity sub so repeated demo sign-ins as
  // the same user collapse to the same auditable subject.
  const subSeed = `${displayName}|${email}`;
  const sub =
    "mock-" +
    crypto.createHash("sha256").update(subSeed).digest("hex").slice(0, 16);

  const sessionCookie = signPayload(
    {
      v: 1,
      sub,
      email,
      displayName,
      roles,
      mock: true,
      iat: now,
      exp: now + oidc.sessionTtlSeconds,
    },
    oidc.sessionSecret
  );

  res.setHeader(
    "set-cookie",
    serializeCookie(oidc.sessionCookieName, sessionCookie, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: oidc.secureCookies,
      maxAge: oidc.sessionTtlSeconds,
    })
  );
  res.statusCode = 302;
  res.setHeader("location", returnTo);
  res.end();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ *
 * Flow helpers
 *
 * These take (oidc, req, res) and do one thing each. They never
 * throw on user-caused problems (tampered state cookie, bad code) —
 * they just 400 with a readable message so an engineer looking at
 * the browser console can diagnose in seconds.
 * ------------------------------------------------------------------ */

const TRANSIENT_COOKIE = "gp_oauth_state";
// 10 minutes is plenty for Azure AD auth; we don't want a tab left
// open overnight to produce a valid callback we have no memory of.
const TRANSIENT_TTL_SECONDS = 600;

/** Build absolute URL for the callback, honouring forwarded headers. */
function absoluteSelfUrl(req) {
  // Prefer X-Forwarded-Host / -Proto (Cloudflare tunnel, corp proxy).
  const proto =
    (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() ||
    (req.socket?.encrypted ? "https" : "http");
  const host =
    (req.headers["x-forwarded-host"] || req.headers.host || "localhost").toString();
  return new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
}

export async function startLoginRedirect(oidc, req, res) {
  if (oidc?.mock) {
    renderMockLoginForm(oidc, req, res);
    return;
  }

  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = randomState();
  const nonce = randomNonce();

  // Bounce-back URL: where the user originally wanted to go. Only
  // accept same-origin paths to avoid open-redirect.
  const returnTo = (() => {
    const raw = (req.query?.return_to ?? "/").toString();
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
    return raw;
  })();

  const stateCookie = signPayload(
    {
      v: 1,
      codeVerifier,
      state,
      nonce,
      returnTo,
      exp: Math.floor(Date.now() / 1000) + TRANSIENT_TTL_SECONDS,
    },
    oidc.sessionSecret
  );
  res.setHeader(
    "set-cookie",
    serializeCookie(TRANSIENT_COOKIE, stateCookie, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: oidc.secureCookies,
      maxAge: TRANSIENT_TTL_SECONDS,
    })
  );

  const authUrl = buildAuthorizationUrl(oidc.config, {
    redirect_uri: oidc.redirectUri,
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Gen Digital users are single-tenant; `login_hint` omitted — let
    // Azure pick the right account if the user is multi-tenant signed in.
    prompt: req.query?.prompt === "select_account" ? "select_account" : undefined,
  });

  res.statusCode = 302;
  res.setHeader("location", authUrl.href);
  res.end();
}

export async function finishLoginCallback(oidc, req, res) {
  const cookies = parseCookies(req);
  const stateCookieRaw = cookies[TRANSIENT_COOKIE];
  const stateCookie = verifyPayload(stateCookieRaw, oidc.sessionSecret);
  if (!stateCookie) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain");
    res.end(
      "Sign-in session expired or tampered with. Please start again from /auth/login."
    );
    return;
  }

  let tokens;
  try {
    const currentUrl = absoluteSelfUrl(req);
    tokens = await authorizationCodeGrant(oidc.config, currentUrl, {
      pkceCodeVerifier: stateCookie.codeVerifier,
      expectedState: stateCookie.state,
      expectedNonce: stateCookie.nonce,
    });
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain");
    res.end(
      `Azure AD token exchange failed: ${err?.message ?? err}\n\n` +
        `If this is a "redirect_uri mismatch", check that the Azure app registration ` +
        `has exactly this URI registered: ${oidc.redirectUri}`
    );
    return;
  }

  const claims = tokens.claims() ?? {};
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  const roles = rolesFromGroups(groups, oidc.roleMap);

  const now = Math.floor(Date.now() / 1000);
  // Session cookie — everything we need to answer "who is this?"
  // without another network trip. We intentionally do NOT store the
  // access token or id token; we've already verified them, and
  // re-validation is an Azure round-trip away via the silent-refresh
  // flow if we ever need it.
  const sessionPayload = {
    v: 1,
    sub: String(claims.oid ?? claims.sub ?? "unknown"),
    email: claims.email ?? claims.preferred_username ?? null,
    displayName:
      claims.name ||
      [claims.given_name, claims.family_name].filter(Boolean).join(" ") ||
      null,
    roles,
    iat: now,
    exp: now + oidc.sessionTtlSeconds,
  };
  const sessionCookie = signPayload(sessionPayload, oidc.sessionSecret);

  res.setHeader("set-cookie", [
    serializeCookie(oidc.sessionCookieName, sessionCookie, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: oidc.secureCookies,
      maxAge: oidc.sessionTtlSeconds,
    }),
    // Clear the transient PKCE cookie — it's single-use.
    serializeCookie(TRANSIENT_COOKIE, "", {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: oidc.secureCookies,
      maxAge: 0,
    }),
  ]);

  const returnTo =
    typeof stateCookie.returnTo === "string" && stateCookie.returnTo.startsWith("/")
      ? stateCookie.returnTo
      : "/";
  res.statusCode = 302;
  res.setHeader("location", returnTo);
  res.end();
}

export function performLogout(oidc, req, res) {
  // Clear our cookie first so a slow Azure redirect can't race.
  res.setHeader(
    "set-cookie",
    serializeCookie(oidc.sessionCookieName, "", {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: oidc.secureCookies,
      maxAge: 0,
    })
  );

  // Mock mode: no Azure, just bounce back to the root.
  if (oidc?.mock) {
    res.statusCode = 302;
    res.setHeader("location", "/");
    res.end();
    return;
  }

  // Try to build an Azure end-session URL so the SSO session is also
  // closed — if the discovery doc didn't expose one (rare), fall back
  // to our own `/`.
  let target = "/";
  try {
    const endSession = buildEndSessionUrl(oidc.config, {
      post_logout_redirect_uri: new URL("/", oidc.redirectUri).href,
    });
    target = endSession.href;
  } catch {
    // no-op; we already cleared the cookie.
  }
  res.statusCode = 302;
  res.setHeader("location", target);
  res.end();
}

/**
 * Given a request, return the decoded session claims if the session
 * cookie is valid, otherwise null. Used by src/auth.js — centralising
 * it here keeps the cookie format in one place.
 */
export function readSessionClaims(oidc, req) {
  const cookies = parseCookies(req);
  const raw = cookies[oidc.sessionCookieName];
  if (!raw) return null;
  return verifyPayload(raw, oidc.sessionSecret);
}
