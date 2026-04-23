# Azure AD / Identity team — app registration request

> **Status (2026-04-20):** filed in ServiceNow as **RITM0213874** (MyApps →
> Add new application → Gen Pulse). Identity team asked to hold execution
> until Kevin emails the go-ahead from senior manager + director. This doc
> was attached to the ticket as the full spec.

Gen Pulse is being rolled out to the EMAIL NORTON CSM team and (soon) the wider CSM org. Senior management gated the roll-out on **Azure AD SSO** replacing the current shared-key demo auth. This doc is a ready-to-forward packet for whoever owns Entra ID / Azure AD app registrations at Gen Digital.

---

## ⚡ Quick start — 10-minute path for the identity admin

If you're the Azure AD admin, skip the email below and do this:

1. In the Microsoft Entra admin centre → **App registrations** → **New registration**.
2. Use the table of settings in the **"App registration settings"** section below.
3. After creating the app, on the **Overview** tab, copy:
  - `Application (client) ID`
  - `Directory (tenant) ID`
4. Under **Certificates & secrets** → **New client secret**, 24-month expiry. Copy the **Value** (NOT the ID).
5. Under **API permissions** → ensure `openid`, `profile`, `email` are present under Microsoft Graph (delegated). Grant admin consent.
6. Under **Token configuration** → **Add groups claim** → `Security groups` → ID. (We use the group GUIDs for role mapping.)
7. Send Kevin the three values (tenant id, client id, client secret) via your usual secret-sharing channel (KeyVault, 1Password, whatever is standard at Gen).

That's it. Kevin handles the rest — populates `.env`, restarts the server, tests the flow. No further action from identity team required unless group membership needs to change.

---

## Email template — forward to the identity / IT admin distribution list

**Subject:** Azure AD app registration request — Gen Pulse (EMAIL NORTON CSM dashboard)

> Hi [identity team lead / IT admin distro],
>
> We've built an internal dashboard called **Gen Pulse** for the EMAIL NORTON CSM team. It consolidates Jira, Workday, and (pending) Slack data into a mobile-first operational cockpit. Senior management has greenlit a wider roll-out on the condition that we authenticate users against Azure AD SSO instead of the current shared-key demo auth.
>
> Could you please create an Azure AD app registration for Gen Pulse, following the spec below? The app is single-tenant, pure OIDC identity (no Graph API calls at runtime, no data-plane permissions).
>
> **App registration settings:**
>
>
> | Setting                                          | Value                                                      |
> | ------------------------------------------------ | ---------------------------------------------------------- |
> | **Name**                                         | `Gen Pulse (EMAIL NORTON pilot)`                           |
> | **Supported account types**                      | `Single tenant — Gen Digital only`                         |
> | **Redirect URI (platform: Web)**                 | `https://<host>/auth/callback` — see "Host URL" note below |
> | **Front-channel logout URL**                     | `https://<host>/`                                          |
> | **API permissions (Microsoft Graph, Delegated)** | `openid`, `profile`, `email` — grant admin consent         |
> | **Client authentication**                        | Confidential client; client secret (24-month expiry)       |
> | **Token configuration → ID token claims**        | Add `groups` (Security groups, GroupID format)             |
> | **Implicit flow**                                | ❌ disabled                                                 |
> | **ID token enabled**                             | ✅                                                          |
> | **Access token enabled**                         | ❌ (we don't call Graph at runtime)                         |
>
>
> **Host URL note:** We'll initially use Gen Pulse on `http://localhost:3000/auth/callback` for dev, plus whatever corporate hostname we get assigned for staging/production. If the easiest path for you is to register all three redirect URIs up front, they are:
>
> - `http://localhost:3000/auth/callback` (engineer laptops)
> - `https://gen-pulse.[whatever corp-internal subdomain you assign].gendigital.net/auth/callback` (staging/prod)
> - Optional: a Cloudflare tunnel URL for mobile demos (we can supply this on request)
>
> **Role mapping (what we need from you beyond the app registration):** We map Gen Pulse roles from Azure AD security-group membership. We'll need the **Object IDs** of:
>
> - the CSM team security group (EMAIL NORTON members) → `member` role
> - the CSM managers group → `manager` role
> - the CSM directors group → `director` role
> - whichever group Gen Pulse admins will live in → `admin` role
>
> If these groups don't exist yet, can you let me know who to ask — I can open a separate ticket for group creation if needed.
>
> **What you'll send back:**
>
> 1. Tenant ID (GUID)
> 2. Application (client) ID (GUID)
> 3. Client secret Value (NOT the ID)
> 4. The four group Object IDs above
>
> Please use your preferred secure-transfer mechanism (KeyVault, 1Password, Bitwarden) — I will **NOT** accept these values over email, Slack DM, or Teams chat.
>
> **Why minimal permissions:** We only need the user's identity (OID, email, display name, groups claim). We never call Microsoft Graph APIs from Gen Pulse, so no `User.Read.All` / `Directory.Read` / similar; the least-privilege footprint is tiny.
>
> **Security posture:**
>
> - OIDC Authorization Code flow with PKCE (no implicit flow, no token in URL fragments)
> - Client secret stored in `.env` with `chmod 600` on the server; rotation supported via re-running `./scripts/set-oidc-secret.sh`
> - Session cookies are `HttpOnly; Secure; SameSite=Lax` and signed with HS256 over an independent random secret
> - ID tokens verified via JWKS on every callback; no long-lived tokens stored server-side
>
> Happy to jump on a call if anything needs clarifying. The whole config is pinned in `teampresence-slack/USER-ACCOUNT-PLAN.md` in our repo and the runtime contract is in `src/oidc.js`.
>
> Thanks,
> Kevin Mold
> EMAIL NORTON CSM

---

## When the credentials arrive — 3-step activation

**Step 1 — put the credentials in `.env` (never in chat, never in commits)**

```bash
cd teampresence-slack
# Paste each value when prompted — NEVER paste them into a chat window:
./scripts/set-oidc-credentials.sh
```

The script sets `OIDC_TENANT_ID`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, a freshly-generated `OIDC_SESSION_SECRET`, and `AUTH_STRATEGY=oidc`. It also auto-fills `OIDC_REDIRECT_URI=http://localhost:3000/auth/callback` for local dev (edit manually for a real hostname).

**Step 2 — populate role mappings from the group Object IDs**

Edit `.env` and add the role map lines below, substituting in the four GUIDs the identity team sent back:

```ini
OIDC_ROLE_MAP_CSM_TEAM=<csm-team-object-id>=member
OIDC_ROLE_MAP_CSM_MANAGERS=<csm-managers-object-id>=manager
OIDC_ROLE_MAP_CSM_DIRECTORS=<csm-directors-object-id>=director
OIDC_ROLE_MAP_PULSE_ADMINS=<pulse-admins-object-id>=admin
```

**Step 3 — restart and verify the login flow**

```bash
pkill -9 -f 'node src/index.js'
PORT=3000 node src/index.js &
sleep 3

# Expect: "[auth] OIDC enabled — issuer=https://login.microsoftonline.com/..."
tail -n 30 /tmp/gen-pulse.log 2>/dev/null || dmesg | tail

# Open the dashboard — you should see a "Sign in with Microsoft" pill top-right:
open http://localhost:3000/

# /auth/status should report enabled:true
curl -s http://localhost:3000/auth/status | python3 -m json.tool
```

Click "Sign in with Microsoft" → Azure AD login page → back to the dashboard with your real name and role in the top-right. Done.

---

## Breakglass — keep the shared key working during rollout

If you want Slack slash-commands, curl scripts, or the Cloudflare demo tunnel to **keep working while SSO is on** (recommended for the first 30 days so ops isn't locked out), set:

```ini
OIDC_ALLOW_SHARED_KEY_FALLBACK=true
```

This makes `?key=<DASHBOARD_KEY>` continue to authenticate non-browser callers. Browser traffic still gets SSO'd — this only unlocks machine-to-machine callers. Turn it off once every integration has been moved to first-class OIDC clients (out of scope for Sprint 2).

---

## Security posture (for the security team's review, if requested)

- **Auth flow:** OIDC Authorization Code + PKCE. No implicit flow. No fragment-bound tokens.
- **Token handling:** ID token verified via Azure JWKS on the callback, then discarded. We never store access tokens (we don't call Graph) or refresh tokens (session re-auth via browser redirect when the cookie expires, default TTL 8h).
- **Session cookies:** `HttpOnly; Secure; SameSite=Lax`, signed with HS256 using a per-deployment random secret (`OIDC_SESSION_SECRET`). Signature uses `crypto.timingSafeEqual` to prevent timing leaks.
- **CSRF:** the `state` param is pinned to a signed transient cookie (PKCE verifier + state + nonce + return_to) that is deleted on successful callback. Replay-safe.
- **Open redirect:** `?return_to=...` on `/auth/login` is restricted to same-origin paths (must start with `/` and not `//`).
- **No passwords:** Gen Pulse never sees credentials. Account lockout, MFA, conditional access — all enforced by Azure AD.
- **Client secret storage:** written to `.env` (gitignored, `chmod 600`). Rotation is a one-command script re-run. No secret ever appears in process argv, logs, or git history.
- **Logout:** `/auth/logout` clears our cookie AND 302s to Azure's end-session endpoint, so admin-revoked sessions kill both layers.

---

## Out of scope for this request

- Any Microsoft Graph permissions (we don't use Graph)
- Multi-tenant configuration (Gen Pulse is single-tenant only by design)
- External IdP federation (Google Workspace, etc.)
- API scopes / custom app roles in the app manifest — we do role mapping from `groups` claim, not from `roles` claim. Keeps the app manifest tiny.

