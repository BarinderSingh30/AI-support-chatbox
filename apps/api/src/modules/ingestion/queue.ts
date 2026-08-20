import pg from 'pg';
import { env } from '../../env.ts';
import { withTenant } from '../../db/with-tenant.ts';
import { ingestionJobs } from '../../db/schema/index.ts';

/**
 * The worker's own connection, using a role whose only cross-tenant reach is an
 * explicit policy on ingestion_jobs (migration 0002). Deliberately separate from
 * the request-path pool so the two cannot be confused.
 */
export const workerPool = new pg.Pool({
  connectionString: env.WORKER_DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
});

export interface ClaimedJob {
  id: string;
  orgId: string;
  documentId: string;
  attempts: number;
  maxAttempts: number;
}

/** Enqueue runs on the request path, so it stays tenant-scoped. */
export async function enqueueJob(orgId: string, documentId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [job] = await tx
      .insert(ingestionJobs)
      .values({ orgId, documentId, state: 'queued' })
      .returning({ id: ingestionJobs.id });
    return job!.id;
  });
}

/**
 * Atomically take the oldest queued job.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run from several workers at
 * once: each transaction locks a different row instead of queueing behind the
 * same one.
 */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  const { rows } = await workerPool.query(
    `UPDATE ingestion_jobs SET
       state = 'running',
       stage = 'parsing',
       locked_at = now(),
       locked_by = $1,
       attempts = attempts + 1
     WHERE id = (
       SELECT id FROM ingestion_jobs
       WHERE state = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, org_id, document_id, attempts, max_attempts`,
    [workerId],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        orgId: row.org_id,
        documentId: row.document_id,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
      }
    : null;
}

export async function updateProgress(jobId: string, stage: string, progressPct: number) {
  await workerPool.query(
    `UPDATE ingestion_jobs SET stage = $2, progress_pct = $3 WHERE id = $1`,
    [jobId, stage, Math.max(0, Math.min(100, Math.round(progressPct)))],
  );
}

export async function completeJob(jobId: string) {
  await workerPool.query(
    `UPDATE ingestion_jobs SET state='succeeded', stage='done', progress_pct=100,
     finished_at=now(), locked_at=NULL, locked_by=NULL WHERE id=$1`,
    [jobId],
  );
}

/** Requeue while attempts remain; give up once they are exhausted. */
export async function failJob(jobId: string, error: string): Promise<'retry' | 'failed'> {
  const { rows } = await workerPool.query(
    `UPDATE ingestion_jobs SET
       state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
       last_error = $2,
       locked_at = NULL,
       locked_by = NULL,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE id = $1
     RETURNING state`,
    [jobId, error.slice(0, 2000)],
  );
  return rows[0]?.state === 'failed' ? 'failed' : 'retry';
}

/**
 * Returns jobs abandoned by a dead worker to the queue.
 *
 * This is the boot-time sweep that replaces a polling loop: nothing here runs on
 * a timer, so an idle Postgres can suspend instead of burning compute budget.
 */
export async function reclaimStalled(staleAfterMs: number): Promise<number> {
  const { rowCount } = await workerPool.query(
    `UPDATE ingestion_jobs SET state='queued', locked_at=NULL, locked_by=NULL
     WHERE state='running' AND locked_at < now() - ($1::int * interval '1 millisecond')`,
    [staleAfterMs],
  );
  return rowCount ?? 0;
}
