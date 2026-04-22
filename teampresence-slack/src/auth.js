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
 * Stub for the OIDC path — NOT wired yet, but here so the
 * factory's public shape is already finalised. When we ship OIDC,
 * the implementation swaps inside this file only — nothing else
 * in the codebase needs to change.
 *
 * See USER-ACCOUNT-PLAN.md for the rollout design.
 */
function createOidcAuthenticator(_opts) {
  throw new Error(
    "OIDC authenticator is not yet implemented. See USER-ACCOUNT-PLAN.md for the roadmap."
  );
}

/**
 * @param {{strategy?: "shared-key" | "bypass" | "oidc", sharedKey?: string}} opts
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
