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
