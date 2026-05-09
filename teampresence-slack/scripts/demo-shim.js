/**
 * demo-shim.js
 *
 * Inlined as the very first <script> tag of dist/index.html by
 * scripts/build-demo.mjs. Turns the live-data dashboard into a
 * pure-static one that runs entirely off `./data/*.json` files
 * served from the same origin.
 *
 * Why a fetch-level shim
 * ======================
 * The live dashboard funnels every backend call through `apiUrl()`
 * (defined later in index.html), so in principle we could just patch
 * that function. But `apiUrl()` is defined deep in the page after a
 * lot of inline script has already run, and some of the early boot
 * code (e.g. /api/me to decide whether to render the sign-in chip)
 * fires before we'd get a chance to swap apiUrl. Patching window.fetch
 * itself runs unconditionally on every request and is therefore the
 * single most reliable interception point.
 *
 * Mapping rule
 * ------------
 *   GET /api/widgets/<id>?team=<t>...  →  ./data/<t>/widgets/<id>.json
 *   GET /api/<path>?team=<t>...        →  ./data/<t>/<path>.json
 *
 * `team` defaults to "norton" — that matches the live server's default
 * and keeps the URL-to-file mapping deterministic for users who
 * deep-link to e.g. `?team=avast`.
 *
 * Synthesised endpoints
 * ---------------------
 * Some endpoints we never snapshot because their content depends on
 * runtime state (the user's Azure AD identity, the live tunnel URL).
 * For those we synthesise a fixed response inline so the rest of the
 * page boots happily:
 *
 *   /api/me        → a logged-in "Demo User" with director role so
 *                    every widget is visible (recruiters see the full
 *                    surface area, not a stripped manager view)
 *   /api/demo-url  → `{ status: "down" }` — there's no tunnel in
 *                    static mode, the share popover stays hidden
 *
 * Auth flow in static mode
 * ------------------------
 * /auth/login, /auth/logout, /auth/callback are all impossible
 * statically. The page has navigation links that point at them; we
 * intercept those clicks and either do nothing (logout) or surface a
 * tiny inline notice (login attempts are no-ops).
 *
 * Failure mode
 * ------------
 * If a JSON file is missing (e.g. someone re-snapshotted with a
 * shrunken widget catalog and a stale link to /api/widgets/foo
 * remains in cached HTML), we return a 503 so the existing widget
 * loaders fall through to their "data unavailable" empty state
 * rather than crashing the page.
 */
(function () {
  "use strict";

  // Mark the page so any UI that wants to opt-out of "live" affordances
  // (e.g. the SSO sign-in chip, the Cloudflare tunnel share popover)
  // can flip itself off in CSS or JS by reading this flag.
  window.__DEMO_MODE__ = true;

  // Resolve the data root relative to the current document URL so the
  // bundle works whether it's served from `https://user.github.io/repo/`
  // or extracted to `file://…/dist/`. We use `new URL(rel, document.baseURI)`
  // throughout to cope with the GitHub Pages "project sites are served
  // under a subpath" quirk.
  const DATA_ROOT = "./data";

  function teamFromUrl(url) {
    const t = (url.searchParams.get("team") || "").toLowerCase();
    if (t === "avast") return "avast";
    if (t === "norton" || t === "email-norton") return "norton";
    return "norton";
  }

  function urlToDataPath(url) {
    if (!url.pathname.startsWith("/api/")) return null;

    const team = teamFromUrl(url);
    const rest = url.pathname.replace(/^\/api\//, ""); // e.g. "widgets/backlog-overview"

    if (rest === "") return null; // /api/ on its own — pass through
    if (rest === "me") return { kind: "synth", which: "me" };
    if (rest === "demo-url") return { kind: "synth", which: "demo-url" };

    return { kind: "file", path: `${DATA_ROOT}/${team}/${rest}.json` };
  }

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status ?? 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // /api/me — synthesise a logged-in director so every role-gated
  // widget is visible. We pick "director" specifically because a
  // viewer (recruiter, hiring manager) seeing a Manager view would
  // miss some widgets that are only enabled at the director level —
  // and the whole point of the demo is to show breadth.
  function synthMe() {
    return jsonResponse({
      signedIn: true,
      auth: "demo",
      mock: false,
      userId: "oidc:demo-user",
      roles: ["director", "manager", "any"],
      displayName: "Demo Viewer",
      firstName: "Demo",
      title: "Director",
      email: "demo@example.com",
      avatarUrl: null,
      initials: "DV",
      profileUrl: null,
      canCustomize: true,
      logoutUrl: "#demo-logout",
    });
  }

  function synthDemoUrl() {
    // `enabled: false` tells the share popover to stay collapsed and
    // hide its "Open public link" affordance — the right behaviour
    // for a static deploy where there IS no public tunnel.
    return jsonResponse({
      enabled: false,
      status: "down",
      url: null,
    });
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    let urlString;
    if (typeof input === "string") urlString = input;
    else if (input && typeof input.url === "string") urlString = input.url;
    else return originalFetch(input, init);

    let url;
    try {
      url = new URL(urlString, document.baseURI);
    } catch {
      return originalFetch(input, init);
    }

    const mapped = urlToDataPath(url);
    if (!mapped) return originalFetch(input, init);

    if (mapped.kind === "synth") {
      if (mapped.which === "me") return Promise.resolve(synthMe());
      if (mapped.which === "demo-url") return Promise.resolve(synthDemoUrl());
    }

    if (mapped.kind === "file") {
      // Use the original fetch (not the patched window.fetch — that
      // would just recurse forever) to load the static JSON file. We
      // also pass `cache: 'no-store'` because GitHub Pages serves
      // assets with long-lived caching by default and we want refreshes
      // to actually re-read updated demo data.
      return originalFetch(mapped.path, { cache: "no-store" }).then((res) => {
        if (res.ok) return res;
        // Translate a 404 (snapshot didn't capture this widget) into
        // a 503 so the live widget loaders show their unavailable
        // state instead of crashing on JSON.parse of an HTML 404 page.
        return jsonResponse(
          {
            unavailable: true,
            error: `demo-snapshot-missing`,
            path: mapped.path,
          },
          503
        );
      });
    }

    return originalFetch(input, init);
  };

  // Intercept clicks on auth-flow links. The static deploy can't do
  // OAuth, so:
  //   - Sign-out → reload (returns the user to a clean state, doesn't
  //                error out)
  //   - Sign-in  → no-op (we already render as "signed in")
  //   - Auth callback links shouldn't appear, but defensively no-op.
  document.addEventListener(
    "click",
    function (e) {
      const a = e.target?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (
        href.startsWith("/auth/login") ||
        href.startsWith("/auth/logout") ||
        href.startsWith("/auth/callback") ||
        href === "#demo-logout"
      ) {
        e.preventDefault();
        if (href.startsWith("/auth/logout") || href === "#demo-logout") {
          // Visual reset only — kicks the user pill back to "Demo Viewer"
          // by re-running loadMe(). Cheaper than a full page reload.
          location.reload();
        }
      }
    },
    true
  );

  // Some of the page's hero buttons render as <button onclick="...">
  // and post forms. We don't expect any in the current build, but if
  // someone adds one, this is where to intercept it.

  // Friendly console banner so anyone debugging in DevTools knows
  // they're looking at the demo build, not the live app.
  try {
    /* eslint-disable no-console */
    console.log(
      "%c[Gen Pulse demo build]%c\nAll /api/* calls served from local JSON. " +
        "No live data, no backend, no network calls to private hosts.",
      "background:#222;color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold;",
      "color:inherit;"
    );
    /* eslint-enable no-console */
  } catch {
    // console may be unavailable in restrictive embeds
  }
})();
