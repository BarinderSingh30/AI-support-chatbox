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

## Two bugs a real browser found that nothing else did

Barinder installed Chromium and the Claude in Chrome extension specifically to close the
verification gap below, and it found two real defects in the first two minutes of clicking —
both invisible to 184 passing tests, two rounds of jsdom verification, and direct curl checks.
Worth recording in full, because the pattern (automated checks constructing requests by hand
instead of exercising the real code path) is exactly what to watch for next time.

**1. An iframe's own outgoing fetch cannot report its parent page's origin.**

The click-through immediately hit "origin not allowed" on every message, despite the widget
key's allowlist being correct. Root cause: the chat UI runs inside an iframe hosted at its
*own* origin. When that iframe's JS calls `fetch()`, the browser's automatic `Origin` header
reports the iframe's own hosting origin — never the parent page's — because that is simply
what the header means. As designed, the origin-allowlist check compared this against
`allowedOrigins`, which is supposed to represent *which client site embeds the widget*. Those
two things can never be the same value in any real deployment: every customer's iframe would
report the identical origin (Groundwork's own widget-hosting domain), so the allowlist could
never distinguish one client from another. This would have shipped completely non-functional.

Fix: the **loader script** runs directly in the parent page's own JS context (a plain
`<script>` tag, not inside an iframe), so `window.location.origin` there genuinely is the real
embedding page's origin. It now captures that and forwards it through the iframe's `src` as an
`origin` query param; the widget app reads it and sends it as a custom `x-widget-origin`
header, which the server checks instead of the structurally-wrong `Origin` header. The real
`Origin` header is still used for its correct purpose — CORS response reflection.

**2. `reply.raw.writeHead()` silently discards Fastify's own queued headers.**

Fixing bug #1 exposed a second one immediately: the widget correctly resolved its origin now,
but every message failed with "Could not connect" — the browser's `fetch()` promise itself
was rejecting. `curl` against the identical request succeeded every time, which was the
tell: this was a browser-enforced CORS rejection, not a real server failure. Root cause:
`streamAnswer` (`chat/stream.ts`) calls `reply.raw.writeHead(200, {...})` to start the SSE
response — a raw Node call that bypasses Fastify's reply pipeline entirely and **discards**
whatever headers were queued via `reply.header()` upstream, including the CORS headers set by
each route's own `onRequest` hook. A CORS preflight (OPTIONS) passes fine, because it goes
through Fastify's normal reply mechanism — the bug only affects the actual streamed response,
which is precisely why neither curl nor the OPTIONS-only parts of the test suite caught it.
Fixed by explicitly carrying `reply.getHeaders()` into the `writeHead()` call. This bug
affected `/v1/chat` too (the session-authenticated route), not just the widget — any
cross-origin caller, including Phase 4's dashboard, would have hit the same silent failure.

**Why the automated checks missed both.** `verify-widget-e2e.mjs` originally granted a widget
key's allowlist entry to the *same port it fetched the bundle from* — conflating "where the
widget is hosted" with "which site embeds it," the exact same category error as bug #1, so the
script's own request pattern could never have exercised the real one. It has since been
rewritten so the widget bundle always loads from one fixed hosting origin while the simulated
parent origin is an unrelated string never actually served from — matching production
topology. Both bugs now have regression tests: `widget.test.ts` asserts the loader forwards
`doc.location.origin`; `widget-chat-e2e.test.ts` asserts the allowlist decision is driven by
`x-widget-origin` even when the raw `Origin` header is deliberately wrong, and separately
asserts the CORS header is present on the *actual* streamed response, not just the preflight.

## Verification

No browser binary was available for most of this phase (`~/.cache/ms-playwright` doesn't
exist, no system Chromium). Three layers were used, in increasing order of realism:

1. **Unit and DOM tests** (184 across the monorepo) — jsdom, real DOM APIs, only the network
   call faked.
2. **`scripts/verify-widget-e2e.mjs`** — loads the actual `vite build` output fresh in a DOM
   environment via real script execution, against a real running API server. Confirms the
   production bundle boots cold, a question streams to a real answer, a citation expands to
   its real excerpt on click, and a non-allowlisted origin is refused end to end.
3. **A real browser, driven live.** Barinder installed Chromium and the Claude in Chrome
   extension mid-phase specifically to close the gap layers 1–2 cannot: nothing had actually
   been *seen* rendering correctly. It immediately found the two bugs documented above. After
   both fixes, a full click-through — open launcher, type a question, get a live Gemini answer
   with a citation, click the citation to reveal the real quoted excerpt — was verified with a
   live server, live Postgres, and live Gemini, and the browser's own console and network
   inspector confirmed zero errors and a correct CORS-headered response.

The lesson this phase leaves for the rest of the project: a verification script that hand-
constructs requests instead of driving the real code path can pass while the real thing is
broken. Prefer exercising the actual client (real click, real fetch call site) over rebuilding
an equivalent request by hand, and when that's not possible, keep the two deliberately close
and note the gap explicitly, as the rewritten `verify-widget-e2e.mjs` now does.

## Deferred

- Per-IP rate limiting (currently per-widget-key only) — the plan's original exit criteria
  mentioned both; per-key alone already gives a meaningful cost/abuse ceiling, and per-IP adds
  real complexity (proxy trust, shared-NAT false positives) that isn't earning its cost yet.
- Multiple widget themes/positions — the launcher is currently fixed bottom-right with one
  color scheme. Configurable in Phase 4's dashboard.
