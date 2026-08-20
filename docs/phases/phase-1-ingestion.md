# Phase 1 — Ingestion Pipeline

**Status:** done 2026-08-20

## Decisions worth remembering

**The worker gets a role-scoped RLS policy, not `BYPASSRLS`.** A queue is inherently
cross-tenant — a worker must see every tenant's pending work to drain it — which collides
with forced row-level security. The fix is `groundwork_worker`, a third role with an explicit
policy granting it access to `ingestion_jobs` and to documents that have a job
(migration 0002). Postgres OR's permissive policies, so tenant isolation stays in force for
every other role, and the worker's reach is visible in the schema rather than hidden in a role
attribute. Once a job is claimed, all document and chunk writes go back through `withTenant`.

**No polling loop.** The worker drains on enqueue and once at boot; nothing runs on a timer.
A conventional Postgres queue polling every two seconds would keep Neon's compute awake
permanently and exhaust the free tier's 100 CU-hours in roughly sixteen days.

**Chunks are replaced, not appended.** Re-embedding deletes and re-inserts inside one
transaction, so a re-run cannot silently double a document's chunk count, and a failure
mid-run leaves the previous chunks intact.

**A short embedding response is fatal.** If the provider returns fewer vectors than texts, we
throw rather than continue. Continuing would pair chunk N with chunk N+1's vector for the rest
of the document — retrieval would still return results, just quietly wrong ones. That is the
worst available failure mode, so it must be loud.

**Extracted text is persisted.** It costs storage but makes re-chunking and re-embedding
possible without re-uploading — which matters, because the chunking strategy is the quality
ceiling and will be tuned once Phase 5's eval scorecard exists.

**Token counts are estimated, not measured.** Gemini's tokenizer is not available offline and
`countTokens` would mean a network round trip per chunk. Four characters per token, with a
chunk budget far below the model's 2048-token input limit, keeps the error harmless.

## Surprises

- The chunk→page mapping forced the chunker to track character offsets, which meant replacing
  `split()` with an offset-aware scan.
- Integration tests could not run in parallel: the queue is cross-tenant, so one test file's
  worker would claim another file's jobs. Fixed with `fileParallelism: false` and by building
  job records directly in pipeline tests instead of claiming them.
- A test that used the app pool to simulate a crashed worker silently updated zero rows —
  RLS was blocking the test itself. Correct behaviour, confusing symptom.

## Deferred

- Object storage for original uploaded files. Extracted text is kept; the source PDF is not.
- Live Gemini verification — `GEMINI_API_KEY` is unset, so the pipeline has only run against
  an injected embedder. First live run opens Phase 2.

## Live verification (2026-08-20)

Run against the real Gemini API, not a stub:

- 24-page synthetic handbook → 4 chunks in ~1.0s.
- Every stored vector: 768 dimensions, L2 norm 1.000000 (min and max).
- Query/document task types produce a comparable space — a warranty question scores the
  warranty passage above the shipping passage.
- Reproduce: `npm run demo:ingest -w @groundwork/api`.

**A bug this caught.** The in-memory PDF test fixture drew each page's text as one long
unwrapped line. pdf.js clips anything past the MediaBox edge, so extraction silently lost
everything after ~99 characters per page — and every E2E test passed happily against the
truncated remainder. The fixture now wraps text to the page width, and
`parsers.test.ts` asserts full round-trip fidelity so it cannot regress. Worth remembering
that a green suite proves nothing about content the fixture never contained.
