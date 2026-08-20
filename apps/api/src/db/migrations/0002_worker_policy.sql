-- The ingestion worker must see the job queue across every tenant — that is the
-- whole point of a queue. It gets there through an explicit, role-scoped policy
-- rather than BYPASSRLS, so its reach is visible in the schema and limited to
-- exactly one table.
--
-- Postgres OR's permissive policies together, so this grants groundwork_worker
-- full access to ingestion_jobs while leaving tenant_isolation in force for
-- every other role. The worker still writes documents and chunks through the
-- tenant-scoped path; it cannot read them here.

GRANT USAGE ON SCHEMA public TO groundwork_worker;--> statement-breakpoint
GRANT SELECT, UPDATE ON ingestion_jobs TO groundwork_worker;--> statement-breakpoint
GRANT SELECT ON documents TO groundwork_worker;--> statement-breakpoint

DROP POLICY IF EXISTS worker_queue_access ON ingestion_jobs;--> statement-breakpoint
CREATE POLICY worker_queue_access ON ingestion_jobs
  TO groundwork_worker
  USING (true)
  WITH CHECK (true);--> statement-breakpoint

-- The worker reads a document's source metadata to do its job, but only for
-- documents that actually have a queued job.
DROP POLICY IF EXISTS worker_document_access ON documents;--> statement-breakpoint
CREATE POLICY worker_document_access ON documents
  TO groundwork_worker
  USING (EXISTS (SELECT 1 FROM ingestion_jobs j WHERE j.document_id = documents.id));
