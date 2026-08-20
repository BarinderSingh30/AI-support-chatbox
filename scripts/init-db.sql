-- Mirrors the manual native setup documented in README.md.
-- CREATE EXTENSION requires superuser, which is why it lives here and not in a migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE groundwork_app LOGIN PASSWORD 'dev_app_pw' NOBYPASSRLS;

-- The ingestion worker drains the job queue across all tenants, so it gets its
-- own role with a policy scoped to ingestion_jobs only (see migration 0002).
-- It still writes documents and chunks through the tenant-scoped app path.
CREATE ROLE groundwork_worker LOGIN PASSWORD 'dev_worker_pw' NOBYPASSRLS;
