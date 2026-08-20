# Changelog

## Phase 0 — Foundations · 2026-08-20

The skeleton the rest of the product hangs off, and the tenancy guarantee that makes it
sellable as multi-tenant software.

- Monorepo (npm workspaces + Turborepo) with an API workspace and a shared types package.
- PostgreSQL 18 with pgvector 0.8.6, running natively rather than in a container.
- 16 tables: seven from Better Auth (users, sessions, organizations, members, invitations)
  and nine of our own (documents, chunks, ingestion jobs, widget keys, chat sessions,
  messages, citations, usage events, per-org settings).
- Email/password authentication with organizations, members, and invitations.
- **Tenant isolation enforced by the database.** Every tenant table has row-level security
  forced on, keyed to a per-transaction setting. The application connects as a role that
  owns nothing and cannot bypass those policies, so a query missing its organization filter
  returns nothing rather than another customer's data.
- Seed data: two demo organizations with deliberately different documents.

## Phase 1 — Ingestion Pipeline · 2026-08-20

Documents go in; searchable, embedded chunks come out.

- Upload PDFs, `.txt`, and `.md` files, or paste raw text.
- PDF text extraction with page tracking, so an answer can cite "page 4".
- Structure-aware chunking: splits on headings first, then paragraphs, then sentences, and
  keeps the heading path with each chunk so a citation reads "Billing › Refunds".
- Overlapping chunks, so a fact split across a boundary survives in one piece.
- Embeddings generated in batches and normalized before storage.
- Re-uploading a file you already have costs nothing — content is fingerprinted, and
  identical content returns the existing document instead of paying to embed it again.
- Ingestion runs in the background with a live progress indicator, and survives a crash:
  work abandoned by a stopped process is picked up and finished on restart.
- Documents can be re-processed without re-uploading, and deleting one removes everything
  derived from it.
- Verified end to end against the live Gemini API: a 24-page handbook is ingested in about a
  second, and every stored vector is correctly sized and normalized.

## Phase 2 — Retrieval & Grounded Chat · 2026-08-20

Questions in, cited answers out — or an honest "I don't know".

- Hybrid retrieval: semantic search and keyword search run together and their results are
  fused, so the system handles both "how long am I covered?" and "what is SKU-4471?".
- Answers cite the exact passage they came from, with document name, section, and page.
- **Questions the documentation cannot answer are refused without calling the language model
  at all.** Those requests cost nothing and cannot hallucinate, because the model never sees
  them. Verified: an out-of-scope question returns in under a second for $0.00.
- An answer that cites nothing is treated as a refusal, however fluent it reads.
- Text from uploaded documents is fenced off in the prompt and explicitly marked untrusted, so
  a document containing "ignore your instructions" cannot hijack the assistant.
- Answers stream token by token rather than appearing all at once.
- Every exchange records its tokens, latency, and cost. A typical answer costs about $0.0003.

## Phase 3 — Embeddable Widget · 2026-08-20

The chatbot can now be dropped onto any website, with no login and no server-side integration
on the client's part.

- A vanilla-JS loader (2.3KB, 1.1KB gzipped) injects a themed launcher and, on click, a chat
  iframe — isolated in a shadow root so it can neither be broken by the host page's CSS nor
  leak its own styling onto it.
- A React chat app runs inside that iframe: streamed answers, an anonymous visitor identity
  and conversation persisted across page loads, and citations that stay collapsed until
  clicked, then reveal the exact source excerpt the answer was built from.
- The widget authenticates by a public key rather than a login, scoped to an exact-match
  allowlist of the domains it's permitted to run on, with its own per-key rate limit and
  monthly message cap enforced before a request reaches the model.
- Widget keys are managed through an admin API: create, list, and revoke, each scoped to the
  organization that owns them.
- Verified against a real running server with the actual production build, and then — after
  installing a browser specifically for this — against a real Chromium click-through: open on
  an unrelated page, ask a real question, get a live Gemini answer with a working citation.
  That browser test caught two real defects no automated check had (an iframe cannot report
  its parent page's origin via the browser's `Origin` header, and a raw response-writing call
  was silently dropping CORS headers on the actual streamed reply); both are now fixed and
  covered by regression tests. Full story in `docs/phases/phase-3-widget.md`.

## Widget greeting and suggested questions · 2026-08-20

Added on top of the already-shipped widget: opening the chat with no prior conversation now
shows a configurable greeting and clickable suggested-question chips instead of a generic
placeholder — closing a gap where the `welcomeMessage` setting existed in the database from
Phase 0 onward but was never actually wired to anything.

- New `GET /v1/widget/config` endpoint, authenticated the same way as chat (public key +
  origin) but deliberately outside the rate limiter and monthly cap — it's a config read on
  mount, not a message, and must not compete with a visitor's actual message budget.
- Suggested questions are admin-curated for now, not derived from real usage. A genuine "most
  asked" list needs the traffic history Phase 5's analytics will provide; this is a reasonable
  placeholder until there's data worth mining.
- Clicking a chip sends its exact text through the same path as typing — same streaming, same
  citations, same session continuity.
- Verified live in a real browser: real greeting, real chips, clicking one produced a real
  Gemini answer with a correct citation, and the chips correctly vanished once the
  conversation started.
