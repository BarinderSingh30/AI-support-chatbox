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
