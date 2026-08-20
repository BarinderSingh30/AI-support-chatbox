# Phase 4 — Admin Dashboard

**Status:** done 2026-08-21

## Decisions worth remembering

**Sign-in only — no self-serve signup or org creation.** Brainstormed and decided before any
code was written: the dashboard's auth UI covers signing in to an existing account, nothing
more. Creating the first user/org for a new deployment is an operational step (seed script,
`POST /api/auth/organization/create`), not a product surface, until Phase 6 makes multi-tenant
self-serve onboarding an actual requirement. Building it now would be scope with no current
buyer.

**Live preview is save-then-remount, not postMessage draft sync.** The widget configurator's
preview is a real `<iframe>` loading the actual `apps/widget-app` build, not a simulated
rendering of the settings form. Two designs were considered: (1) stream every keystroke into
the iframe via `postMessage` so the preview updates live as you type, or (2) debounce edits,
save to the API, and remount the iframe (via a changing `key`) once the save lands. (2) was
chosen — it exercises the real save path end-to-end (so "what you see in the preview" and
"what a visitor would actually get" can never drift apart, since they're loading through the
identical `GET /v1/widget/config` a real visitor hits), at the cost of the preview lagging
`DEBOUNCE_MS` (600ms) behind typing rather than being instant. For an admin tuning a handful of
settings, that tradeoff reads as "saving," not "laggy."

**Theming was cut, not deferred with a stub.** The `theme` column on `org_settings` has existed
since Phase 0. Phase 4's design review confirmed nothing in the widget actually reads it yet —
building a dashboard editor for it would ship a control with zero effect, which is worse than
not shipping it, since it would look like a bug rather than an intentionally missing feature.
Revisit once the widget itself has something to theme.

**Unanswered-question mining groups by exact text, not semantic similarity.** "What's your
return policy" and "how do returns work" currently count as two separate unanswered questions
rather than one cluster of two. Real semantic clustering needs an eval set to validate the
clustering itself doesn't produce misleading groupings — building it before Phase 5's eval set
exists would mean shipping something un-validatable. Carried forward explicitly to Phase 5's
checklist so it doesn't quietly disappear.

## Two real bugs only a real browser session found

Both invisible to 251 passing tests across the monorepo, direct `curl` checks against every
affected endpoint, and the SDD review process's independent task-by-task code review (14 tasks,
each reviewed by a fresh model instance against the real API contracts). Consistent with
Phase 3's finding: automated checks that never drive an actual browser miss an entire class of
defect, because several of the mechanisms below (CORS enforcement, iframe-origin semantics) are
implemented by the browser itself, not by any code this project owns.

**1. `reply.hijack()` skipped `@fastify/cors`'s response-header hook — every sign-in silently
succeeded server-side while the browser discarded the response.**

`apps/api/src/auth/plugin.ts` hands the raw request/response to Better Auth's Node handler via
`reply.hijack()`, because Better Auth needs the unparsed request stream and reads/writes the
raw Node objects directly. `reply.hijack()` tells Fastify to stop managing the response —
which also means Fastify's `onSend` hook chain never runs for that response, and
`@fastify/cors`'s header injection is implemented as exactly such a hook. The OPTIONS preflight
that precedes every cross-origin `POST` is unaffected (it's handled by `@fastify/cors`'s
`onRequest` hook, before the route handler — and therefore before the hijack — ever runs), so
every browser correctly completed a preflight, then sent the real request, which the server
processed completely correctly: it validated the credentials, created a session, set the
cookie, and returned 200. The browser's own CORS enforcement then discarded that response
because it arrived with no `Access-Control-Allow-Origin` header, and `fetch()` rejected with a
bare `TypeError: Failed to fetch` — indistinguishable, from the caller's side, from the request
never having reached the server at all.

This is what made the bug unusually hard to see from any single vantage point: the server's own
request log showed a clean `200` for every attempt (nothing to investigate there), `curl`
against the identical request succeeded every time (CORS is a browser-only enforcement — curl
doesn't perform it, so the bug is invisible to any check built on curl or an equivalent raw
HTTP client), and the earlier automated Chrome session that hit the same failure looked, at
first, like a tooling artifact of that session's own resource pressure — not a code defect —
until a second, independent human browser session reproduced the identical failure and ruled
that explanation out.

Fix: since `reply.header()` is buffered for a `send()` that a hijacked response never performs,
the CORS headers have to be written directly onto `reply.raw` — using the same origin allowlist
(`[BETTER_AUTH_URL, DASHBOARD_URL]`) the `@fastify/cors` plugin is configured with elsewhere in
`app.ts`, checked before the hijack. Regression test: `apps/api/tests/auth-cors.test.ts` asserts
the headers land on the actual POST response (not just the preflight), and that an origin
outside the allowlist gets none.

**2. The widget configurator's live preview could silently render the wrong content, with no
error, because it reused an arbitrary existing widget key instead of one scoped correctly.**

`WidgetConfigurator.tsx` needs *some* widget key to load the preview iframe against. The
original logic took `keys[0]` — the first key returned by `GET /v1/widget-keys` — without
checking whether that key's `allowedOrigins` actually included the dashboard's own origin. In
manual verification, an unrelated widget key (created moments earlier, for testing the widget
directly, scoped to `http://localhost:5173`) happened to sort first; the preview picked it, and
every `GET /v1/widget/config` request it made was correctly rejected with 403 by the API's
existing origin-allowlist check (working exactly as designed) — but the widget-app's own
`fetchWidgetConfig` treats *any* failed config fetch as non-fatal and falls back to a generic
built-in greeting, precisely so a visitor is never blocked from chatting by a transient config
hiccup. That fallback is correct behavior for a real visitor-facing widget and exactly wrong
for an admin's live preview: the preview rendered, looked functional, and simply never reflected
whatever the admin had saved.

Fix: the preview now filters for a key that is both non-revoked and already scoped to
`window.location.origin`, and mints a dedicated one otherwise, rather than trusting `keys[0]`.
Regression tests in `apps/dashboard-app/tests/widget-configurator.test.tsx` cover both the
wrong-origin case and the revoked-key case (the latter wasn't reachable at review time, since no
revoke UI existed yet — it is now, as of the very next task in this same plan).

**Why the review process didn't catch either one.** Both bugs are enforced by the browser
itself (CORS response blocking; the structural fact that a failed `fetch` can't distinguish
"server rejected me" from "browser discarded a headerless response"), not by any code path a
reviewer reading a diff, or a jsdom-based unit test with a mocked `fetch`, can exercise. The
review process here (14 tasks, each independently reviewed against the real API contracts by a
fresh model instance) caught real defects throughout — including flagging the exact `keys[0]`
line above as fragile — but graded its reachability from the code alone, without a real browser
enforcing real origin rules to demonstrate the failure. This is the same lesson Phase 3 recorded
under a different bug: a check that hand-constructs a request, or never drives an actual browser
at all, cannot observe a browser-enforced behavior — full story in `docs/phases/phase-3-widget.md`.

## Verification

1. **Unit and integration tests** — 251 passing across all 5 workspaces (`npm run test` from
   the repo root), plus a clean `npm run typecheck` and `npm run build` across every workspace.
2. **A live, real signed-in browser session**, run manually after the automated Chrome session
   hit the CORS bug above and a naive read of the symptom (clean server logs, curl succeeding)
   looked like a tooling artifact rather than a real defect:
   - Signed in to the dashboard as a real user against a real running API and Postgres.
   - Uploaded a document; it ingested to `ready` with 1 chunk.
   - Opened the widget-app dev URL directly and asked it a real question.
   - Confirmed in the dashboard: the conversation appears in Conversations with its full
     transcript; Analytics reports **4 total messages**, **answer rate 0.25**, **$0.000239**
     total cost, and 3 unanswered questions.
   - Cross-checked every one of those figures against the raw database, independent of the
     dashboard's own code: `chat_messages` has exactly 4 `role = 'assistant'` rows for the org
     (1 `answered = true`, 3 `answered = false` — the same 0.25 rate, computed a second way from
     a different table); `usage_events` has exactly 6 rows for the org (2 `kind = 'chat'`, 4
     `kind = 'embed'`) summing to exactly `$0.000239`; the 3 unanswered questions returned by
     `GET /v1/analytics/unanswered` match the 3 `answered = false` message contents verbatim.

## Deferred

- Self-serve sign-up and organization-creation UI — Phase 6 (see "Decisions worth remembering"
  above and `docs/superpowers/specs/2026-08-20-phase-4-admin-dashboard-design.md`).
- Semantic clustering of unanswered questions — Phase 5, once the eval set exists to validate
  clustering quality (see above).

## Cut

- Widget theming (the `theme` column on `org_settings`) and any dashboard editor for it —
  nothing in the widget renders it yet.
