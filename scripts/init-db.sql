-- Mirrors the manual native setup documented in README.md.
-- CREATE EXTENSION requires superuser, which is why it lives here and not in a migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE groundwork_app LOGIN PASSWORD 'dev_app_pw' NOBYPASSRLS;
