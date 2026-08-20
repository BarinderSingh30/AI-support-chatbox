-- Mirrors the manual native setup documented in README.md.
-- CREATE EXTENSION requires superuser, which is why it lives here and not in a migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE groundwork_app LOGIN PASSWORD 'dev_app_pw' NOBYPASSRLS;

-- The ingestion worker drains the job queue across all tenants, so it gets its
-- own role with a policy scoped to ingestion_jobs only (see migration 0002).
-- It still writes documents and chunks through the tenant-scoped app path.
CREATE ROLE groundwork_worker LOGIN PASSWORD 'dev_worker_pw' NOBYPASSRLS;

-- Anonymous widget visitors have no session and no org context — the public
-- key on the <script> tag IS how the org is determined, so that one lookup
-- cannot go through the tenant-scoped app pool. This role can SELECT active
-- widget_keys across all tenants and nothing else (see migration 0006). Public
-- keys are shipped to browsers by design, so this is not a confidentiality
-- leak; it is the intended discovery path.
CREATE ROLE groundwork_public LOGIN PASSWORD 'dev_public_pw' NOBYPASSRLS;
