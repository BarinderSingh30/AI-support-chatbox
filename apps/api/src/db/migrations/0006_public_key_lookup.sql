-- Lets the widget-visitor lookup path resolve a public key to its organization
-- without a session or tenant context. Scoped to exactly one table and to
-- active keys only — the same narrow-policy pattern used for the ingestion
-- worker in migration 0002, not a general RLS bypass.
--
-- This is not a confidentiality relaxation: widget public keys are shipped to
-- browsers by design (visible in any client site's page source), and the other
-- columns exposed (allowed_origins, rate limits) are operational config, not
-- secrets.

GRANT USAGE ON SCHEMA public TO groundwork_public;--> statement-breakpoint
GRANT SELECT ON widget_keys TO groundwork_public;--> statement-breakpoint

DROP POLICY IF EXISTS public_key_lookup ON widget_keys;--> statement-breakpoint
CREATE POLICY public_key_lookup ON widget_keys
  TO groundwork_public
  USING (revoked_at IS NULL);
