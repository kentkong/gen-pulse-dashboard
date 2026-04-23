/**
 * Authentication abstraction.
 *
 * Today Gen Pulse gates every `/api/*` call on a single shared
 * `DASHBOARD_KEY` — fine for internal dogfooding, not fine for
 * production. This module wraps that mechanism behind a small
 * authenticator interface so we can swap in Azure AD / OIDC / etc.
 * without touching route code.
 *
 * Strategies supported:
 *
 *   "shared-key"   — DASHBOARD_KEY ?key=... or `Authorization: Bearer
 *                    <key>`. Users are anonymised (sub = "anon",
 *                    roles = []). Current default.
 *
 *   "bypass"       — Never reject. Useful for local dev when no key
 *                    is set. Equivalent to the current "no key = open
 *                    door" behaviour in authorized().
 *
 *   "oidc"         — Planned (see USER-ACCOUNT-PLAN.md). Will verify
 *                    a bearer JWT signed by Gen Digital's Azure AD
 *                    tenant and decode standard claims (sub, email,
 *                    name, groups → roles).
 *
 * Consumer API:
 *
 *   const auth = createAuthenticator({ strategy, sharedKey });
 *   const { ok, user } = auth.authenticate(req);
 *   if (!ok) return res.status(401).json(auth.challenge());
 *
 * `user` is a `Claim`:
 *   {
 *     sub:         "anon" | "oidc:<oid>",
 *     email:       string | null,
 *     displayName: string | null,
 *     roles:       string[],
 *   }
 *
 * Even today, routes that want future-proofing can read `user` —
 * it's always present (at minimum `{ sub: "anon", roles: [] }`) so
 * consumer code doesn't need null-checks once the OIDC strategy
 * lands.
 */

import { readSessionClaims } from "./oidc.js";

/** @typedef {{sub:string, email:string|null, displayName:string|null, roles:string[]}} Claim */

const ANON_CLAIM = Object.freeze({
  sub: "anon",
  email: null,
  displayName: null,
  roles: [],
});

function extractBearer(req) {
  const header = (req.headers?.authorization ?? "").trim();
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

function extractSharedKey(req) {
  // ?key=... wins because a user who clicks a magic link is
  // explicitly authenticating; the Authorization header is a
  // fallback for API clients and curl scripting.
  return (
    req.query?.key?.toString().trim() ||
    extractBearer(req) ||
    ""
  );
}

function createSharedKeyAuthenticator(sharedKey) {
  const key = (sharedKey ?? "").trim();
  // Empty key == open door, matching the pre-existing behaviour
  // authorized() had in src/web.js.
  if (!key) return createBypassAuthenticator({ reason: "no DASHBOARD_KEY set" });

  return {
    strategy: "shared-key",
    authenticate(req) {
      const provided = extractSharedKey(req);
      if (provided && provided === key) {
        return { ok: true, user: ANON_CLAIM };
      }
      return { ok: false, user: ANON_CLAIM, reason: "invalid-or-missing-key" };
    },
    challenge() {
      return {
        error: "Unauthorized",
        hint: "Append ?key=<DASHBOARD_KEY> to the URL or send it as a Bearer token.",
      };
    },
  };
}

function createBypassAuthenticator({ reason } = {}) {
  return {
    strategy: "bypass",
    authenticate(_req) {
      return { ok: true, user: ANON_CLAIM };
    },
    challenge() {
      return { error: "Unauthorized", hint: "(bypass mode; should not be reachable)" };
    },
    reason: reason ?? null,
  };
}

/**
 * OIDC path — session-cookie based. The actual Azure AD round-trip
 * lives in src/oidc.js (login / callback / logout routes mounted in
 * src/web.js). Here we just answer "does THIS request carry a valid
 * session cookie?" on every API call, which must be cheap (pure HMAC
 * verify, no network).
 *
 * Two compatibility knobs:
 *
 *   - `allowSharedKeyFallback`: when true, requests carrying a valid
 *     `?key=DASHBOARD_KEY` or `Authorization: Bearer <key>` are
 *     accepted as anonymous. This is the breakglass path — the Slack
 *     slash commands, curl scripts, and Cloudflare tunnels all keep
 *     working during the OIDC rollout.
 *
 *   - Missing/expired cookie -> { ok: false, challenge.loginUrl: "/auth/login" }.
 *     The dashboard JS treats this as "show the Sign in button"
 *     rather than bouncing the user through Azure on every refresh.
 */
function createOidcAuthenticator(opts) {
  const oidc = opts.oidc;
  if (!oidc?.ready) {
    throw new Error(
      "createOidcAuthenticator: oidc not initialised. Call initOidcFromEnv first and pass the result in."
    );
  }
  const sharedKey = (opts.sharedKey ?? "").trim();
  const allowSharedKeyFallback = Boolean(opts.allowSharedKeyFallback && sharedKey);

  return {
    strategy: "oidc",
    authenticate(req) {
      const session = readSessionClaims(oidc, req);
      if (session) {
        return {
          ok: true,
          user: {
            sub: `oidc:${session.sub}`,
            email: session.email ?? null,
            displayName: session.displayName ?? null,
            roles: Array.isArray(session.roles) ? session.roles : [],
          },
        };
      }
      if (allowSharedKeyFallback) {
        const provided = extractSharedKey(req);
        if (provided && provided === sharedKey) {
          return { ok: true, user: ANON_CLAIM };
        }
      }
      return {
        ok: false,
        user: ANON_CLAIM,
        reason: "no-session",
      };
    },
    challenge() {
      return {
        error: "Unauthorized",
        loginUrl: "/auth/login",
        hint: "Sign in with Microsoft (Azure AD) to access the dashboard.",
      };
    },
  };
}

/**
 * @param {{
 *   strategy?: "shared-key" | "bypass" | "oidc",
 *   sharedKey?: string,
 *   oidc?: import("./oidc.js").OidcConfig,
 *   allowSharedKeyFallback?: boolean,
 * }} opts
 */
export function createAuthenticator(opts = {}) {
  const strategy = opts.strategy ?? "shared-key";
  switch (strategy) {
    case "shared-key":
      return createSharedKeyAuthenticator(opts.sharedKey);
    case "bypass":
      return createBypassAuthenticator(opts);
    case "oidc":
      return createOidcAuthenticator(opts);
    default:
      throw new Error(`Unknown auth strategy: ${strategy}`);
  }
}

/**
 * Express-style middleware factory that wraps any authenticator.
 * Usage in src/web.js:
 *
 *   const auth = createAuthenticator({ sharedKey: process.env.DASHBOARD_KEY });
 *   const requireAuth = makeAuthMiddleware(auth);
 *   router.get("/api/foo", requireAuth, handler);
 *
 * We don't use this yet — routes call `auth.authenticate(req)` by
 * hand — but it's here so the future refactor is a one-file change.
 */
export function makeAuthMiddleware(authenticator) {
  return (req, res, next) => {
    const result = authenticator.authenticate(req);
    if (!result.ok) {
      return res.status(401).json(authenticator.challenge());
    }
    req.user = result.user;
    next();
  };
}

export { ANON_CLAIM };
