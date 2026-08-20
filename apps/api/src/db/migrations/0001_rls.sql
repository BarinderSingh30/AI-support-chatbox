-- Tenant isolation, enforced by Postgres rather than by application discipline.
--
-- Every tenant-scoped table gets RLS with a policy keyed on `app.org_id`, a
-- per-transaction GUC set by withTenant(). The application role owns nothing and
-- has NOBYPASSRLS, so a query that forgets its org filter returns zero rows
-- instead of another tenant's data.
--
-- Note: RLS does NOT apply to a table's owner unless FORCE ROW LEVEL SECURITY is
-- set. Migrations run as groundwork_owner, which owns these tables, so FORCE is
-- what makes the guarantee real rather than theoretical.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'documents',
    'document_chunks',
    'ingestion_jobs',
    'widget_keys',
    'chat_sessions',
    'chat_messages',
    'message_citations',
    'usage_events',
    'org_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = current_setting('app.org_id', true))
        WITH CHECK (org_id = current_setting('app.org_id', true))
    $f$, t);
  END LOOP;
END $$;--> statement-breakpoint

-- The application role: can read and write rows, can never create or own objects.
GRANT USAGE ON SCHEMA public TO groundwork_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO groundwork_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO groundwork_app;--> statement-breakpoint

-- Future tables created by the owner get the same grants automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE groundwork_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO groundwork_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE groundwork_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO groundwork_app;
