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
