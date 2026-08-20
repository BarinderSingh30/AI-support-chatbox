# Groundwork

**An embeddable AI support chatbot that answers strictly from your own documents.**

Upload your documentation, FAQ, or policy PDFs. Drop four lines of HTML into your site.
Visitors get answers grounded in *your* content — with citations pointing back to the exact
source passage, and an honest "I don't know" when the answer isn't in the corpus.

> **Status:** In development. See [ROADMAP.md](./ROADMAP.md) for what's built and what's next.

---

## Why this exists

Most support chatbots are a general-purpose LLM with a system prompt taped to the front. They
answer confidently about refund policies you don't have and features you never shipped.

Groundwork inverts that. Retrieval runs first, and the model only ever sees passages pulled
from the customer's own knowledge base. If nothing relevant is found, the model is **never
called at all** — the request short-circuits to a graceful fallback. That single design
decision removes an entire class of hallucination and cuts inference cost on exactly the
queries that were never going to produce a good answer.

## What's in the box

- **Multi-tenant by construction.** Every organization's documents, conversations, and
  analytics are isolated at the *database* layer via Postgres Row Level Security — not by
  remembering to write `WHERE org_id` in application code.
- **Grounded answers with citations.** Every claim links to the chunk it came from, showing
  document, section heading, and page number.
- **Graceful refusal.** "I don't know" is a designed feature with its own test, not an
  accident.
- **Hybrid retrieval.** Semantic vector search fused with keyword search via Reciprocal Rank
  Fusion, so exact terms like error codes and SKUs aren't lost to embedding fuzziness.
- **Embeds anywhere.** A <5KB loader script injects an iframe, so the widget can't collide
  with the host page's CSS, its React version, or its globals.
- **Cost visibility.** Token usage and spend recorded per organization, per conversation,
  with hard monthly caps enforced before dispatch.

## Architecture

```
 Client's website          Admin dashboard
   <script> → iframe          React + Vite
        │                         │
        └────────┬────────────────┘
                 ▼
        Fastify API  ──  withTenant(orgId) → SET LOCAL app.org_id
                 │              (the only path to the database)
     ┌───────────┼────────────┐
     ▼           ▼            ▼
  Ingestion   Hybrid       Gemini API
   worker     search    embeddings + chat
     │           │            │
     └───────────┴────────────┘
                 ▼
        Neon Postgres + pgvector
     documents · chunks · sessions
     messages · citations · usage
        RLS enforced on every table
```

Ingestion is asynchronous and durable: upload returns immediately, a worker parses, chunks,
and embeds in batches, and job progress streams to a live progress bar. If the process dies
mid-job, a boot-time sweep reclaims the stalled work.

Full detail in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) *(lands in Phase 0)*.

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Fastify + TypeScript | First-party multipart, rate-limit, and CORS plugins |
| ORM | Drizzle | First-class pgvector column support; SQL-shaped hybrid queries |
| Auth | Better Auth + organization plugin | Self-hosted, owns users in our own Postgres |
| Database | Neon Postgres | pgvector included; scale-to-zero without project pauses |
| Vectors | pgvector, same database | Transactional deletes and RLS coverage for free |
| Embeddings | `gemini-embedding-001` @ 768d | GA model; fits pgvector's 2000-dim HNSW ceiling |
| LLM | `gemini-2.5-flash` | Grounded extraction doesn't need frontier reasoning |
| Frontend | React + Vite + Tailwind | Static build, hosts free, no SSR server to pay for |

The LLM provider sits behind an interface — swapping Gemini for Claude or GPT is one file.

Design decisions and their reasoning are recorded as ADRs in
[`docs/DECISIONS.md`](./docs/DECISIONS.md) *(lands in Phase 0)*.

## Getting started

**Prerequisites:** Node 22+, Docker (for local Postgres with pgvector), and a Gemini API key.

Local setup lands with the monorepo scaffold in Phase 0 — see [ROADMAP.md](./ROADMAP.md) for
current progress. The intended flow:

```bash
npm install
cp .env.example .env      # add your GEMINI_API_KEY
docker compose up -d      # postgres + pgvector
npm run db:migrate
npm run seed              # two demo orgs with different content
npm run dev
```

## License

MIT
