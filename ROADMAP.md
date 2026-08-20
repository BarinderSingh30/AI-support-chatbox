# Roadmap

**Current phase:** Phase 4 — Admin Dashboard
**Status:** ⬜ Not started
**Last updated:** 2026-08-20
**Live demo:** not yet deployed — target Phase 6

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundations — repo, monorepo, schema, auth, tenancy | ✅ Done — 2026-08-20 |
| 1 | Ingestion pipeline — parse, chunk, embed, store | ✅ Done — 2026-08-20 |
| 2 | Retrieval + grounded chat API | ✅ Done — 2026-08-20 |
| 3 | Embeddable widget | ✅ Done — 2026-08-20 |
| 4 | Admin dashboard | ⬜ Not started |
| 5 | Hardening + retrieval evals | ⬜ Not started |
| 6 | Deploy + case study | ⬜ Not started |

> **Minimum sellable cut: Phases 0–4.** Stopping there still leaves a complete, demonstrable
> product. Phases 5–6 are what turn a working product into a case study.

**Key:** ✅ done · 🟡 in progress · ⬜ not started · ⏸️ paused · ❌ cut *(with a reason — cut
scope stays visible so the record stays honest)*

---

## ✅ Phase 0 — Foundations   `done 2026-08-20`

- [x] Initialize repository
- [x] `.gitignore`, `README.md`, `ROADMAP.md`
- [x] npm workspaces + Turborepo + shared tsconfig
- [x] Local Postgres 18 + pgvector (native on Arch); `docker-compose.yml` kept for portability
- [x] Drizzle schema + first migration; `pgvector` extension enabled
- [x] Better Auth + organization plugin (orgs, members, invitations)
- [x] RLS policies on every app table; app role without `BYPASSRLS`
- [x] `withTenant()` helper — the only path to the database
- [x] Seed script: two demo orgs with deliberately different content

**Demo:** sign up → create an org → invite a second user → land on an empty dashboard.
**Exit criteria:** `npm test` passes — 5/5 in `tests/tenant-isolation.test.ts`. ✅
**Verified:** scoped reads return only the caller's rows; a query naming another org returns
0; an unscoped query returns 0; a cross-tenant INSERT is rejected by Postgres with
`new row violates row-level security policy`; the app role reports `rolbypassrls = false`.
**Notes:** `FORCE ROW LEVEL SECURITY` is load-bearing — RLS does not apply to a table's owner
without it, and migrations run as the owner. See `docs/phases/phase-0-foundations.md`.

---

## ✅ Phase 1 — Ingestion Pipeline   `done 2026-08-20`

- [x] Upload endpoint — multipart, PDF/txt/md, with size cap
- [x] Paste-raw-text path
- [x] PDF parsing via `unpdf`; cleanup (dehyphenation, cruft removal)
- [x] Heading-aware chunker — ~600 tokens, 15% overlap, `heading_path` retained
- [x] Batched embedding — `gemini-embedding-001`, `RETRIEVAL_DOCUMENT`, 768 dims
- [x] **L2-normalize every vector** (required at any non-3072 dimension)
- [x] Durable job rows with retry + boot-time sweep for stalled work
- [x] `content_hash` dedupe so re-uploading a file costs nothing
- [x] Live progress bar driven by job status

**Demo:** drag in a 40-page PDF, watch a live progress bar, browse the resulting chunks with
their heading paths and page numbers.
**Exit criteria:** `npm test` — 58 passing across 9 files. ✅
**Verified:** pasted text and uploaded PDFs both produce chunks with heading paths and page
numbers; every vector is 768-dim and L2-normalized; re-uploading identical content returns the
existing document without re-embedding; deleting a document removes its chunks; a job whose
worker died is reclaimed and completed; an unsupported file type is refused with 415.
**Live-verified against Gemini:** a 24-page PDF ingests in ~1.0s to 4 chunks; every stored
vector is 768-dimensional with an L2 norm of exactly 1.000000; a query embedding ranks the
semantically relevant passage above an irrelevant one. Reproduce with
`npm run demo:ingest -w @groundwork/api`.
**Deferred:** object storage for original files — extracted text is persisted in Postgres so
re-chunking works, but the original PDF is not retained. Cloudflare R2 in a later phase.

---

## ✅ Phase 2 — Retrieval + Grounded Chat API   `done 2026-08-20`

- [x] Query embedding with `task_type=RETRIEVAL_QUERY`
- [x] pgvector cosine kNN over an HNSW index
- [x] tsvector keyword search
- [x] Reciprocal Rank Fusion of both result sets
- [x] **Relevance gate** — short-circuit to "I don't know" before any LLM call
- [x] Grounding prompt with mandatory `[n]` citations, versioned in its own file
- [x] SSE streaming response
- [x] Persist messages, citations, tokens, latency, and cost

**Demo:** a scratch HTML page answering questions with sources — *and* a question the docs
don't cover, refused cleanly.
**Exit criteria:** expected source document appears in the top 5 for ≥80% of the eval set; an
out-of-corpus question records `answered = false` with **zero** LLM tokens, proving the gate
fired before the call rather than after.

---

## ✅ Phase 3 — Embeddable Widget   `done 2026-08-20`

- [x] Vanilla loader script (<5KB) that injects a themed iframe
- [x] React chat UI inside the iframe
- [x] Widget-key management API (create/list/revoke, admin session-authenticated)
- [x] Streaming token render
- [x] Citation chips that expand to show the quoted passage
- [x] Public-key auth with exact-match origin allowlist (via a loader-captured `x-widget-origin`
      header, not the browser's `Origin` header — see notes below for why)
- [x] Per-key rate limiting (in-process sliding window) + per-key monthly message cap

**Demo:** paste four lines of HTML into an unrelated static site and have it work.
**Exit criteria:** `npm test` — 184 passing across the monorepo. ✅
**Verified live, in an actual Chromium browser** (installed mid-phase for exactly this):
open the launcher on an unrelated static page, ask a real question, get a live Gemini answer
streamed in with a correct citation, click the citation to reveal the real quoted excerpt —
zero console errors, correct CORS headers, confirmed via the browser's own Network/Console
inspectors, not inferred from logs.
**Two real bugs only the browser caught** — both invisible to 184 passing tests and two
rounds of jsdom-based verification: (1) an iframe's own `fetch()` structurally cannot report
its parent page's origin via the `Origin` header, which would have made the origin allowlist
non-functional for every real deployment; (2) `reply.raw.writeHead()` was silently discarding
CORS headers Fastify had queued upstream, so the actual streamed response — not the OPTIONS
preflight — shipped with no `Access-Control-Allow-Origin`, invisible to curl since CORS is
browser-enforced only. Full root-cause writeup, including why the automated verification
missed both: `docs/phases/phase-3-widget.md`.

---

## ⬜ Phase 4 — Admin Dashboard

- [ ] Document library — status, size, chunk count, re-embed, delete
- [ ] Conversation browser with full transcripts and the citations each answer used
- [ ] Analytics — messages over time, answer rate, spend by day
- [ ] **Top unanswered questions**, mined from low-`top_score` messages
- [ ] Widget configurator with live preview
- [ ] Widget key management — create, revoke, set allowed origins and caps

**Demo:** the full loop — upload a document, chat from the widget, watch the conversation and
its cost appear in the dashboard.
**Exit criteria:** dashboard message count, answer rate, and cost figures match the
`usage_events` rows for the same window.

---

## ⬜ Phase 5 — Hardening + Evals

- [ ] Retrieval eval set (~30 question/expected-source pairs)
- [ ] `npm run eval` printing a hit-rate@k scorecard
- [ ] Per-org monthly spend caps enforced before dispatch
- [ ] Structured logging
- [ ] Integration tests: tenancy boundary, "I don't know" path, prompt-injection resistance
- [ ] CI: typecheck, lint, test, and a lint rule forbidding direct DB imports outside
      `with-tenant.ts`

**Demo:** `npm run eval` printing a retrieval scorecard.
**Exit criteria:** scorecard runs in CI; exceeding a test org's monthly cap refuses requests
with a clear error rather than silently charging.
**Open:** whether to add a reranker — decide from the scorecard, not in advance.

---

## ⬜ Phase 6 — Deploy + Case Study

- [ ] Dashboard, widget, and landing page to Vercel
- [ ] API to Render free tier
- [ ] GitHub Actions cron keeping the API warm (744h/mo fits the 750h allowance)
- [ ] Neon production database + migrations
- [ ] Public demo org preloaded with a fictional company's docs, one-click entry
- [ ] Landing page with a live embedded widget
- [ ] Case study write-up

**Demo:** the URL that goes on the Upwork profile.
**Exit criteria:** from a machine that has never hit the demo, a cold load completes a
conversation in under 5 seconds to first token.

---

## Phase gate ritual

A phase is not done when the tests pass. It is done when this file says so. At every gate:

1. Tick the phase's boxes; flip its heading to ✅ and stamp the completion date.
2. Update the banner — current phase, status, `Last updated` — and the summary table row.
3. Add a `CHANGELOG.md` entry in language a non-engineer could follow.
4. Write closing notes in `docs/phases/phase-N-*.md` — surprises, deferrals, new ADRs.
5. Move anything discovered-but-undone into the **next** phase's checklist. Scope that
   quietly evaporates is exactly what this file exists to catch.
6. Commit.
