import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { documents, organization } from '../src/db/schema/index.ts';
import {
  claimNextJob, enqueueJob, failJob, reclaimStalled, workerPool,
} from '../src/modules/ingestion/queue.ts';

const orgA = `q-a-${randomUUID()}`;
const orgB = `q-b-${randomUUID()}`;

async function makeDoc(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      orgId, title: 'doc', sourceType: 'paste', contentHash: randomUUID(),
    }).returning();
    return doc!.id;
  });
}

beforeEach(async () => {
  await db.delete(organization).where(eq(organization.id, orgA));
  await db.delete(organization).where(eq(organization.id, orgB));
  await db.insert(organization).values([
    { id: orgA, name: 'A', slug: orgA, createdAt: new Date() },
    { id: orgB, name: 'B', slug: orgB, createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgA));
  await db.delete(organization).where(eq(organization.id, orgB));
  await pool.end();
  await workerPool.end();
});

describe('ingestion queue', () => {
  it('claims a job that was enqueued', async () => {
    const docId = await makeDoc(orgA);
    const jobId = await enqueueJob(orgA, docId);
    const claimed = await claimNextJob('worker-1');
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.orgId).toBe(orgA);
    expect(claimed?.attempts).toBe(1);
  });

  it('does not hand the same job to a second worker', async () => {
    await enqueueJob(orgA, await makeDoc(orgA));
    const first = await claimNextJob('worker-1');
    const second = await claimNextJob('worker-2');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('gives concurrent workers different jobs', async () => {
    await enqueueJob(orgA, await makeDoc(orgA));
    await enqueueJob(orgA, await makeDoc(orgA));
    const [a, b] = await Promise.all([claimNextJob('w1'), claimNextJob('w2')]);
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();
    expect(a?.id).not.toBe(b?.id);
  });

  it('requeues a failed job while attempts remain', async () => {
    await enqueueJob(orgA, await makeDoc(orgA));
    const job = await claimNextJob('w1');
    expect(await failJob(job!.id, 'boom')).toBe('retry');
    // Back in the queue, so another worker can pick it up.
    expect((await claimNextJob('w2'))?.id).toBe(job!.id);
  });

  it('gives up after max attempts', async () => {
    await enqueueJob(orgA, await makeDoc(orgA));
    let outcome = '';
    for (let i = 0; i < 3; i++) {
      const job = await claimNextJob(`w${i}`);
      outcome = await failJob(job!.id, 'boom');
    }
    expect(outcome).toBe('failed');
    expect(await claimNextJob('w9')).toBeNull();
  });

  it('reclaims a job whose worker died mid-run', async () => {
    // The reason jobs live in Postgres at all: a crash must not lose work.
    await enqueueJob(orgA, await makeDoc(orgA));
    const job = await claimNextJob('doomed-worker');
    // Backdate the lock through the worker pool. Going via `db` would be
    // silently blocked by RLS (no tenant set) and update zero rows.
    await workerPool.query(
      `UPDATE ingestion_jobs SET locked_at = now() - interval '30 minutes' WHERE id = $1`,
      [job!.id],
    );
    expect(await reclaimStalled(10 * 60_000)).toBe(1);
    expect((await claimNextJob('healthy-worker'))?.id).toBe(job!.id);
  });

  it('keeps jobs invisible to a tenant that does not own them', async () => {
    await enqueueJob(orgA, await makeDoc(orgA));
    const seenByB = await withTenant(orgB, (tx) =>
      tx.execute('SELECT count(*)::int AS n FROM ingestion_jobs'),
    );
    const rows = (seenByB.rows ?? seenByB) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });
});
