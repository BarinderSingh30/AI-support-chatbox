# Phase 0 — Foundations

**Status:** done 2026-08-20

## What shipped

Monorepo, database, authentication, and the tenant-isolation boundary.

## Decisions worth remembering

**768-dimension vectors, not 3072.** pgvector's HNSW index caps the `vector` type at 2000
dimensions, because an index tuple must fit inside Postgres's 8KB page. Gemini's default
output is 3072 and is therefore unindexable. `gemini-embedding-001` supports Matryoshka
truncation, and Google's guidance is that 768 retains near-peak quality at a quarter of the
storage. The column is declared `vector(768)` with an HNSW index using `vector_cosine_ops`.

**`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** RLS is not applied to a table's owner
unless forced. Migrations run as `groundwork_owner`, which owns every table — so without
`FORCE`, the policies would be decorative for exactly the role most likely to be misused.

**Two database roles.** `groundwork_owner` runs migrations and owns objects.
`groundwork_app` is what the API connects as: `NOBYPASSRLS`, owns nothing, holds only
DML grants. The isolation test asserts `rolbypassrls = false` so this cannot silently
regress.

**`CREATE EXTENSION vector` is not in a migration.** It requires superuser, and the
migration role deliberately is not one. Migration `0000_init.sql` opens with a guard that
raises a clear error if the extension is absent instead of failing obscurely later.

**Connection pool has a short idle timeout.** Neon's free tier bills compute by the hour and
suspends after five minutes idle; a pool that holds connections open pins the compute awake
and exhausts the monthly budget in roughly two weeks. Same reason the ingestion worker in
Phase 1 must not poll.

## Surprises

- The Better Auth CLI moved to a package named `auth`; `@better-auth/cli` is deprecated and
  stalled at 1.4.21 while the library is at 1.7.1.
- Better Auth reads the raw Node request stream, so Fastify's built-in JSON parser has to be
  removed *within the auth plugin's scope* — an encapsulated wildcard parser alone does not
  override built-ins. Other routes keep normal JSON parsing.
- `organization.id` is `text`, not `uuid`, so every `org_id` column follows suit.
- Better Auth rejects state-changing requests without an `Origin` header
  (`MISSING_OR_NULL_ORIGIN`). Correct behaviour; worth knowing when testing with curl.

## Deferred to later phases

- Object storage for original uploaded files (Phase 1).
- Email delivery for invitations — currently created as `pending` rows with no email sent.
