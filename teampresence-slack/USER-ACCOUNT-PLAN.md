# Gen Pulse — User Account Plan (Azure AD SSO)

**Status:** Design doc. Not yet implemented. Shipping target: Sprint 2 / early Sprint 3.

**Why now:** The senior-manager review was green on condition that the dashboard authenticates users against Gen Digital SSO before going beyond the EMAIL NORTON pilot team. This doc pins down the design so an implementation sprint can start without further architectural debate.

---

## What "login" means on this dashboard

A small avatar+name control in the **top-right of the hero header** — matching the placement the user requested. Clicking it:

- when **signed out** (or session expired): opens a full-page SSO redirect to Azure AD, returns to the originally-requested URL.
- when **signed in**: opens a popover with `Signed in as Alice Smith · Customer Success · Manager`, with a `Sign out` link and a `Switch account` link.

Everything else on the page stays exactly as it is today — this is a surface-layer change, not a redesign.

---

## Constraints we're designing against

1. **Gen Digital identity provider is Azure AD.** No external IdP. No local passwords.
2. **No password management.** All auth decisions come from Azure claims; we never see a credential.
3. **Group-based roles.** Gen Digital likely already has AD groups like `csm-email-norton-team` and `csm-email-norton-managers`. Role mapping comes from claim groups, not a Gen Pulse database.
4. **Backwards-compatible.** The current `DASHBOARD_KEY` path must continue to work for local dev and offline demos. We toggle via `AUTH_STRATEGY`.
5. **Stateless.** No session DB. Use signed cookies (or keep the JWT client-side). Simpler horizontal scaling.
6. **Zero new secrets the admin can leak.** Client secret rotation lives in Azure KeyVault or the equivalent, not in a git-committed file.

---

## High-level architecture

```
┌────────────┐      1. GET /?scroll=widget          ┌────────────────────┐
│  Browser   │ ────────────────────────────────────▶│  Gen Pulse server  │
│  (user)    │                                       │  (src/index.js +   │
│            │       2. 302 → Azure AD /authorize    │   src/web.js)      │
│            │ ◀──────────────────────────────────── │                    │
│            │                                       │  auth.js strategy: │
│  3. sign in on Azure (MFA if required)             │  "oidc"            │
│            │                                       │                    │
│            │       4. 302 back to /auth/callback   │                    │
│            │ ────────────────────────────────────▶ │                    │
│            │                                       │  5. verifies id_token│
│            │                                       │     via JWKS       │
│            │       6. Set-Cookie: gp_session=<JWT> │                    │
│            │ ◀──────────────────────────────────── │                    │
│            │       7. 302 → original URL           │                    │
│  8. GET /api/widgets/...    Cookie: gp_session=... │                    │
│            │ ────────────────────────────────────▶ │  authenticate(req) │
│            │                                       │  → { ok, user {    │
│            │                                       │    sub, email,     │
│            │                                       │    displayName,    │
│            │                                       │    roles: […]      │
│            │                                       │  }}                │
└────────────┘                                       └────────────────────┘
```

**Flow: OIDC Authorization Code + PKCE.** We do NOT use implicit flow.

---

## Azure AD app registration (what IT will create)

| Setting | Value |
| ------- | ----- |
| Name | `Gen Pulse (Email Norton Pilot)` |
| Account type | Gen Digital tenant only (single-tenant) |
| Redirect URI (Web) | `https://gen-pulse.corp.gendigital.net/auth/callback` |
| Front-channel logout URL | `https://gen-pulse.corp.gendigital.net/auth/logout-complete` |
| ID token enabled | ✅ |
| Access token enabled | ❌ (we only need identity, not Graph access — follow principle of least privilege) |
| Implicit flow | ❌ |
| Supported audiences | `api://gen-pulse` (custom scope) + `openid profile email` |
| Client authentication | Confidential client, secret stored in Azure KeyVault |
| Optional claims | Add `groups` (security group IDs), `preferred_username`, `given_name`, `family_name` |

**Note for IT:** we don't need API permissions on MS Graph. The `groups` claim in the ID token is enough to do role mapping server-side.

---

## Claim → role mapping

Server config, shipped in `.env`, consumed by `src/auth.js` at boot:

```
AUTH_STRATEGY=oidc
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<app-id-from-azure>
OIDC_CLIENT_SECRET=<from-keyvault>
OIDC_REDIRECT_URI=https://gen-pulse.corp.gendigital.net/auth/callback
OIDC_SESSION_SECRET=<random-64-bytes-for-cookie-signing>
OIDC_SESSION_COOKIE=gp_session
OIDC_SESSION_TTL_MINUTES=480

# Role mapping — claim group ID → role. Multiple mappings allowed.
OIDC_ROLE_MAP=<azure-group-id-csm-team>=member
OIDC_ROLE_MAP_2=<azure-group-id-csm-managers>=manager
OIDC_ROLE_MAP_3=<azure-group-id-csm-directors>=director
OIDC_ROLE_MAP_4=<azure-group-id-gen-pulse-admins>=admin
```

The resulting `Claim` for a signed-in user:

```ts
{
  sub: "oidc:<azure-oid>",
  email: "alice.smith@gendigital.com",
  displayName: "Alice Smith",
  roles: ["member", "manager"]
}
```

Roles are **additive** — if a user is in both `team` and `managers` groups, they get both roles. This is how we later gate the director/manager drill-down view.

---

## Server-side implementation sketch

All changes live in `src/auth.js`, which already exports `createAuthenticator({ strategy, ...opts })`. New branch:

```js
// src/auth.js

function createOidcAuthenticator(opts) {
  const verifyIdToken = jwksClientVerify(opts.issuer, opts.clientId);
  const roleMap = parseRoleMap(opts.roleMap);  // [{groupId, role}]

  return {
    strategy: "oidc",
    authenticate(req) {
      const cookie = readSignedCookie(req, opts.cookieName, opts.sessionSecret);
      if (!cookie) return { ok: false, user: ANON_CLAIM };
      try {
        const payload = verifyIdToken(cookie);   // throws if expired / tampered
        return {
          ok: true,
          user: {
            sub:         `oidc:${payload.oid ?? payload.sub}`,
            email:       payload.email ?? payload.preferred_username ?? null,
            displayName: payload.name ?? null,
            roles:       rolesFromGroups(payload.groups ?? [], roleMap),
          },
        };
      } catch (_) {
        return { ok: false, user: ANON_CLAIM };
      }
    },
    challenge() {
      return { error: "Unauthorized", loginUrl: "/auth/login" };
    },
  };
}
```

Two new routes in `src/web.js` (added only when strategy === "oidc"):

- `GET  /auth/login` — generates PKCE, stashes state in a short-lived cookie, 302 to Azure `/authorize`.
- `GET  /auth/callback` — exchanges code for id_token, verifies, sets signed session cookie, 302 to original URL.
- `POST /auth/logout` — clears cookie, 302 to Azure end-session endpoint.

We will use the well-maintained [`openid-client`](https://github.com/panva/node-openid-client) library for this — battle-tested, does PKCE and JWKS automatically.

---

## UI: the top-right login control

New component, inserted into the existing hero header. Mount point: already reserved in `public/index.html` — just need to replace the spot currently occupied by the theme toggle + quicklinks with a three-item flex row.

**Signed-out state:**

```
┌────────────────┐
│  Sign in · SSO │
└────────────────┘
```

Tap → `/auth/login`.

**Signed-in state:**

```
┌──────────────────────────────────────┐
│ [🅐] Alice Smith · Customer Success   │
└──────────────────────────────────────┘
```

Tap → popover:

```
┌──────────────────────────────────────┐
│ [🅐] Alice Smith                      │
│      alice.smith@gendigital.com       │
│      Roles: member · manager          │
│                                      │
│      [ Switch account ]  [ Sign out ] │
└──────────────────────────────────────┘
```

We already have `/api/me` returning the user identity — once OIDC is wired, that endpoint reads `req.user` (populated by the auth middleware) instead of the current `users.info` call.

---

## Security considerations

1. **CSRF:** `/auth/callback` already pins the `state` param against a PKCE cookie. Session cookie is `SameSite=Lax; HttpOnly; Secure` so no cross-site JS can read it.
2. **Clock skew / replay:** verify `exp`, `iat`, `nbf`; `openid-client` does this by default.
3. **Token leakage:** we never put the ID token in local storage — cookie only.
4. **Session fixation:** cookie is signed with HS256 + a server-side secret; rotation invalidates all sessions.
5. **Account lockout:** handled by Azure AD, not by us. We never see passwords.
6. **Back-channel logout:** Azure will call our logout endpoint when the admin revokes a session. We expire the cookie immediately.

---

## Migration plan (3 steps)

1. **Pre-flight (1 day):** IT creates the Azure app registration, hands us the client id + secret + redirect URI. Meanwhile, we bring in `openid-client` and stub the new routes behind `AUTH_STRATEGY=oidc`.
2. **Staging flip (1 day):** Point a test hostname at staging. Flip `AUTH_STRATEGY=oidc` there. Walk through the flow ourselves. Verify the claim shape, role mapping, and that the `/api/me` endpoint returns the right person.
3. **Pilot flip (0.5 day):** Flip `AUTH_STRATEGY=oidc` in production. `DASHBOARD_KEY` continues to work as a fallback-auth scheme for 30 days so ops/dev don't get locked out during teething. Announce to the pilot team the day before.

Total effort: ~3 engineering days after IT delivers the app registration.

---

## What's NOT in this plan

- **Adding role-gated UI surfaces** (director drill-down, etc). That's Sprint 3 and beyond — once claim shape is stable, gating individual widgets on `user.roles.includes("manager")` is a 1-line change per widget.
- **Consent screen customization** in Azure — inherited from Gen's tenant defaults.
- **GitHub OAuth.** Out of scope for now (the GitHub integration requested by the user is for *reading* repo data, not for authenticating users).
- **Multi-tenant support.** Not needed — Gen Pulse is single-tenant (Gen Digital only) by design.
