# Phase 3 — Embeddable Widget

**Status:** done 2026-08-20

## Decisions worth remembering

**A third database role for the public key lookup, following the Phase 1 worker pattern.**
An anonymous visitor has no session and no org context — the public key on the `<script>` tag
*is* how the org gets determined, so that one lookup cannot go through `withTenant`. Rather
than granting a bypass, `groundwork_public` gets a policy scoped to exactly one table
(`widget_keys`) and exactly active rows (migration `0006`). This is not a confidentiality
relaxation: the public key is shipped to every visitor's browser by design, and the other
exposed columns (origins, rate limits) are operational config, not secrets.

**CORS had to be actively un-scoped from the public route, not just left permissive.**
`@fastify/cors`, registered at the app root, auto-handles every OPTIONS preflight in its
scope and was silently rejecting the widget's cross-origin requests before they ever reached
the route's own logic — the failure looked like a broken origin check when the actual bug was
one plugin registration line above it. Fixed by moving the admin routes into their own
encapsulated Fastify context and registering the public widget routes as a sibling, with their
own hand-rolled CORS headers. The real authorization boundary is the per-key origin allowlist
in application code, which returns a readable 403; CORS here only decides whether a *browser*
gets to read that response, since a direct server-to-server call was never stopped by CORS
regardless.

**Rate limiting is in-process, not `@fastify/rate-limit`.** The per-key limit is stored in the
database and must be read to know what to enforce — which is the same lookup the origin check
already performs. Threading a DB-derived dynamic limit through the plugin's hook ordering
added more complexity than it removed, so the limiter is a small, fully-tested sliding window
keyed by widget key id instead. Documented tradeoff: state resets on process restart and isn't
shared across instances, which is fine for the single-instance Render deployment this project
targets and would need Redis if that ever changed.

**Citations excerpt the real source text, not just its coordinates.** The original design
only carried document/heading/page. Reviewing the plan's own exit criteria — "citation chips
that expand to show the quoted passage" — caught the gap before calling the phase done. The
excerpt is truncated server-side and travels through the same SSE payload already in place, so
the frontend change was a rendering toggle, not a new round trip.

## Environment quirks hit and resolved

- **Node 26 ships an experimental global `localStorage`** that throws unless
  `--localstorage-file` is passed, and it silently shadows jsdom's own implementation in
  vitest. Fixed with `NODE_OPTIONS=--no-experimental-webstorage` on the widget-app's test and
  dev scripts. This is exactly the kind of version-specific trap the project's environment
  rules exist to catch — it would have read as "jsdom is broken" without checking `node --help`.
- **`@testing-library/user-event`'s default import resolves to the whole module namespace**
  under this project's `nodenext` + `verbatimModuleSyntax` combination, losing the `setup`/
  `type`/`click` methods that are genuinely declared in its `.d.ts`. The named import
  (`import { userEvent } from ...`) resolves correctly. Not fully root-caused — plausibly an
  edge case in TypeScript 7's early native compiler — but the workaround is stable and cheap.
- **A mocked `Response` reused across multiple `fetch` calls throws `ReadableStream is
  locked`** on the second read, because `mockResolvedValue` evaluates its argument once and
  replays the same instance. A real `fetch()` always returns a fresh `Response`. This was a
  test bug, not a widget bug, but a believable one to ship: fixed by constructing a fresh
  mock `Response` per call (`mockImplementation`) everywhere the pattern appeared.
- **jsdom's `window` has no `fetch`/`ReadableStream` of its own.** Verifying the built bundle
  in jsdom needed Node's real `fetch` assigned onto the jsdom window. One resulting gap: a
  real browser auto-attaches an `Origin` header derived from page context; Node's `fetch` has
  no such concept and won't add one. That header is the only thing shimmed in the verification
  script — everything else about each request (method, the `x-widget-key` header, the body)
  is constructed by the real app code and sent for real.

## Verification

No browser binary is available in this environment (`~/.cache/ms-playwright` doesn't exist,
no system Chromium). Rather than skip visual verification silently, this phase used three
layers instead, in increasing order of realism:

1. **Unit and DOM tests** (34 tests across the loader and widget-app) — jsdom, real DOM APIs,
   only the network call faked.
2. **`scripts/verify-widget-e2e.mjs`** — loads the actual `vite build` output fresh in a DOM
   environment via real script execution, and drives it against a real running API server
   (Fastify, real Postgres, injected chat/embedder for speed and determinism). Confirms: the
   production bundle boots from cold, a question streams to a real answer, a citation expands
   to its real excerpt on click, and a non-allowlisted origin is refused end to end. Rerun
   twice to rule out a fluke; both runs passed cleanly with no hanging processes.
3. **`scripts/demo-embed.mjs`** — boots the real stack against live Gemini and serves
   `apps/widget-loader/demo/test-host.html`, an unrelated-looking static page, for a human to
   open in an actual browser and click through. This closes the one gap the first two layers
   cannot: nothing here has been *seen* rendering correctly. Owed to Barinder as a manual step.

## Deferred

- Per-IP rate limiting (currently per-widget-key only) — the plan's original exit criteria
  mentioned both; per-key alone already gives a meaningful cost/abuse ceiling, and per-IP adds
  real complexity (proxy trust, shared-NAT false positives) that isn't earning its cost yet.
- Multiple widget themes/positions — the launcher is currently fixed bottom-right with one
  color scheme. Configurable in Phase 4's dashboard.
- A real browser click-through, per the verification section above.
