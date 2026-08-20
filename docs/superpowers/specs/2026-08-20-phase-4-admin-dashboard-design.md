# Phase 4 — Admin Dashboard: Design

**Status:** Approved 2026-08-20, pending implementation plan.
**Roadmap item:** [ROADMAP.md](../../../ROADMAP.md) Phase 4.

## Why

Phases 0–3 built the product's engine (tenancy, ingestion, retrieval, the embeddable widget)
but gave org admins no way to see any of it working except by querying Postgres directly.
Phase 4 is the operator-facing half of the minimum sellable cut: upload/manage documents,
read real conversations, see cost and answer-rate at a glance, tune the widget, and manage
embed keys — all through the UI a client would actually click around in during a demo.

## Scope decision: auth UI

No sign-in/sign-up UI exists anywhere yet — only the Better Auth backend (email/password +
organization plugin) and a seed script that creates orgs but no users. Phase 4 ships
**sign-in only**: a single email/password form against the existing Better Auth endpoints.
Org/user creation stays manual (seed script or direct API call) for now.

**Cut, with reason:** self-serve sign-up + "create your organization" is explicitly deferred
to Phase 6, where it belongs next to the public demo org and landing page — building it twice
(once minimal here, once polished for the landing page) is wasted work.

## Architecture

### New workspace: `apps/dashboard-app`

Same toolchain as `apps/widget-app` — React 19, Vite, Tailwind v4, Vitest + Testing Library —
plus two additions:

- **`react-router`** (declarative mode) — the dashboard is genuinely multi-page
  (sign-in, documents, conversations, conversation detail, analytics, widget config, widget
  keys) and deep-linkable URLs matter for an admin tool a client will bookmark and share.
- **`better-auth/react`** client with the `organizationClient()` plugin — the officially
  supported way to drive the existing Better Auth backend from React; avoids hand-rolling
  session/org-switch logic against raw endpoints.

No new data-fetching library. `widget-app` already does typed plain-`fetch` + `useEffect` +
local loading/error state (see `lib/sse.ts`, `lib/config.ts`) and that pattern carries over
cleanly to a screen count this small. A `lib/api.ts` helper wraps `fetch` with
`credentials: 'include'`, the API base URL, JSON parsing, and typed error throwing; each
screen owns its own fetch effect. Revisit (TanStack Query) only if a later phase adds
heavier client state — not needed for Phase 4.

### Auth flow

1. `POST` via `authClient.signIn.email({ email, password })`.
2. On success, `authClient.useListOrganizations()`:
   - **Exactly one org** → `authClient.organization.setActive({ organizationId })` → enter
     dashboard automatically.
   - **Zero orgs** → show "no organization yet — contact an admin" (no self-serve path, per
     the scope decision above).
   - **More than one** → show an org picker; selecting one calls `setActive`.
3. A persistent header shows the active org and lets the user switch (re-runs `setActive`)
   and sign out (`authClient.signOut()`).
4. A layout route wraps every authenticated screen; if `useSession()` resolves to no user, it
   redirects to `/sign-in`. This is a UX convenience only — the real boundary is still the
   API's `requireOrg` guard and Postgres RLS, exactly as today.

### Routes

```
/sign-in
/                     → redirect to /documents
/documents
/conversations
/conversations/:id
/analytics
/widget               (configurator + live preview)
/widget-keys
```

## New API modules

All registered inside the existing session-authenticated `admin` group in `app.ts` (the one
already wrapping `documentRoutes`, `chatRoutes`, `widgetKeyRoutes` behind CORS +
`authPlugin`). Each new module follows the established shape: a `requireOrg` preHandler hook,
`withTenant(orgId, ...)` for every query, zod validation on writes — the same shape as
`modules/documents/routes.ts` and `modules/widget-keys/routes.ts`.

### `modules/conversations/routes.ts`

- `GET /v1/conversations?limit=50&offset=0` — session list: `id`, `visitorId`, `origin`,
  `startedAt`, `lastMessageAt`, message count (subquery/count over `chatMessages`). Ordered by
  `lastMessageAt desc nulls last`.
- `GET /v1/conversations/:id` — full transcript: every `chatMessages` row for the session in
  order, each assistant message's citations joined through `messageCitations` →
  `documentChunks` → `documents` for title/heading/page, matching the shape the widget itself
  already renders (`documentTitle`, `headingPath`, `pageFrom`, `excerpt`).

### `modules/analytics/routes.ts`

- `GET /v1/analytics/overview?days=30` — from `chatMessages` and `usageEvents` grouped by
  `date_trunc('day', created_at)` within the window:
  - `messagesByDay: { date, count }[]`
  - `costByDay: { date, costUsd }[]`
  - `answerRate: number` (`count(answered=true) / count(answered is not null)` — messages
    where the gate never had a chance to fire, i.e. `answered is null`, are excluded so
    partial/in-flight rows don't skew the rate)
  - `totalMessages`, `totalCostUsd` for the window
- `GET /v1/analytics/unanswered?days=30&limit=20` — user messages whose paired assistant
  reply has `answered = false`, grouped by exact `content` text, ordered by frequency desc.
  **Deliberately exact-text grouping, not semantic clustering** — fuzzy "similar questions"
  clustering is retrieval-eval territory that belongs with Phase 5's eval set, not bolted onto
  a dashboard report.

### `modules/org-settings/routes.ts`

- `GET /v1/org-settings` — returns the `orgSettings` row (or defaults if none exists yet,
  mirroring `getWidgetConfig`'s lazy-row pattern).
- `PUT /v1/org-settings` — upsert, scoped to fields that actually affect a live conversation
  today: `welcomeMessage`, `suggestedQuestions`, `systemPrompt`, `noAnswerMessage`, `minScore`,
  `topK`.

**Cut, with reason:** `theme` (a `jsonb` column that already exists on `orgSettings`) is
**not** exposed by this endpoint and gets no editor. Nothing reads it — `widget-app`'s
`WidgetConfig` type carries only `welcomeMessage` and `suggestedQuestions` — so a theme editor
would configure a setting with no effect. Widget theming is a widget-side feature; building it
only to unlock a dashboard control is scope creep in the wrong direction. Flagged in
`ROADMAP.md` under Phase 4 as deferred, not silently dropped.

### `modules/widget-keys`

Untouched. Phase 4 adds a UI (list/create/revoke, set allowed origins, set caps) against the
routes that already exist from Phase 3.

## Widget configurator + live preview

The preview embeds the actual widget via the existing loader/iframe path (not a mock), pointed
at one of the org's widget keys — auto-created via the existing `createWidgetKey` service if
the org has none yet. Editing a field debounces ~600ms, then `PUT /v1/org-settings`; on a
successful save the preview iframe is re-keyed (forced remount), which makes it re-fetch
config from the API the same way a real embed does on load.

Rejected alternative: pushing draft edits into the iframe via `postMessage` for instant preview
without saving. More moving parts (a draft-sync protocol the real widget doesn't otherwise
need) for a preview that would then show something not actually live — the save-then-remount
approach is simpler and never shows the admin something that isn't true.

## CORS / env

Add `DASHBOARD_URL` (default `http://localhost:5174`) to `apps/api/src/env.ts`'s schema, and
include it alongside `BETTER_AUTH_URL` in the `admin` group's `cors` `origin` array in
`app.ts`. `widget-app` runs on Vite's default `5173`; `dashboard-app` takes `5174` to avoid
collision when both run via `turbo run dev`.

## Testing

- **API**: Vitest per new module, following the existing per-module `tests/` convention.
  Priority is tenant isolation — a second org's session must get empty/404 results from every
  new endpoint, exactly like `tests/tenant-isolation.test.ts` verifies for the existing
  tables. Also cover the transcript/citation join shape and the unanswered-questions grouping.
- **Dashboard app**: Vitest + Testing Library per screen, mirroring `widget-app/tests`' setup
  (mocked `fetch`, no live network). Auth flow (single org auto-select, multi-org picker,
  zero-org message) gets explicit coverage since it's new and easy to get subtly wrong.
- **Charts**: analytics screen visuals are hand-rolled SVG per the `dataviz` skill — no
  charting library dependency — invoked at implementation time for that screen specifically.

## Out of scope for Phase 4 (carried forward or cut)

- Self-serve sign-up / org creation UI → Phase 6 (landing page, public demo org).
- Widget theming (colors) and its dashboard editor → cut; no consumer for it yet.
- Semantic clustering of "similar" unanswered questions → Phase 5 (retrieval evals).
- Object storage for original uploaded files → already deferred from Phase 1, unaffected here.
