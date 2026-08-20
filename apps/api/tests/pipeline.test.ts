import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { documentChunks, documents, organization } from '../src/db/schema/index.ts';
import { enqueueJob, workerPool } from '../src/modules/ingestion/queue.ts';
import type { ClaimedJob } from '../src/modules/ingestion/queue.ts';
import { processJob } from '../src/modules/ingestion/pipeline.ts';
import type { Embedder } from '../src/modules/ingestion/embedder.ts';
import { l2Normalize } from '../src/modules/ingestion/vectors.ts';

const org = `p-${randomUUID()}`;

/** Deterministic stand-in: 768 dims, normalized, seeded by text length. */
const fakeEmbedder = (calls: { count: number }): Embedder => ({
  embedDocuments: async (texts) => {
    calls.count += texts.length;
    return texts.map((t) =>
      l2Normalize(Array.from({ length: 768 }, (_, i) => Math.sin(i + t.length))),
    );
  },
  embedQuery: async () => l2Normalize(Array.from({ length: 768 }, (_, i) => Math.cos(i))),
});

async function seedDocument(text: string, pageBreaks?: number[]) {
  return withTenant(org, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      orgId: org, title: 'Handbook', sourceType: 'md',
      contentHash: randomUUID(), extractedText: text, pageBreaks, status: 'pending',
    }).returning();
    return doc!.id;
  });
}

/**
 * Builds the job record directly rather than claiming from the queue: claiming
 * is cross-tenant by design, so a claim here could pick up another test's work.
 * processJob is the unit under test; claiming is covered in queue.test.ts.
 */
async function jobFor(docId: string): Promise<ClaimedJob> {
  const id = await enqueueJob(org, docId);
  return { id, orgId: org, documentId: docId, attempts: 1, maxAttempts: 3 };
}

beforeEach(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.insert(organization).values({ id: org, name: 'P', slug: org, createdAt: new Date() });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
  await workerPool.end();
});

describe('processJob', () => {
  it('turns a document into stored, embedded chunks', async () => {
    const docId = await seedDocument('# Refunds\n\nRefunds are issued within 14 days.');
    const calls = { count: 0 };
    await processJob(await jobFor(docId), { embedder: fakeEmbedder(calls) });

    const chunks = await withTenant(org, (tx) =>
      tx.select().from(documentChunks).where(eq(documentChunks.documentId, docId)),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(calls.count).toBe(chunks.length);
    expect(chunks[0]?.headingPath).toBe('Refunds');
    expect(chunks[0]?.embedding).toHaveLength(768);
  });

  it('marks the document ready and records its counts', async () => {
    const docId = await seedDocument('Some content about warranties and coverage.');
    await processJob(await jobFor(docId), { embedder: fakeEmbedder({ count: 0 }) });

    const [doc] = await withTenant(org, (tx) =>
      tx.select().from(documents).where(eq(documents.id, docId)),
    );
    expect(doc?.status).toBe('ready');
    expect(doc?.chunkCount).toBeGreaterThan(0);
    expect(doc?.embeddingModel).toBeTruthy();
  });

  it('stores page numbers when the source had pages', async () => {
    const text = 'Page one content here.\n\nPage two content here.';
    const docId = await seedDocument(text, [0, text.indexOf('Page two')]);
    await processJob(await jobFor(docId), { embedder: fakeEmbedder({ count: 0 }) });

    const chunks = await withTenant(org, (tx) =>
      tx.select().from(documentChunks).where(eq(documentChunks.documentId, docId)),
    );
    expect(chunks.every((c) => c.pageFrom !== null)).toBe(true);
  });

  it('replaces old chunks instead of appending them on re-run', async () => {
    // Re-embedding a document must not silently double its chunk count.
    const docId = await seedDocument('First body of text for the document.');
    await processJob(await jobFor(docId), { embedder: fakeEmbedder({ count: 0 }) });
    const before = await withTenant(org, (tx) =>
      tx.select().from(documentChunks).where(eq(documentChunks.documentId, docId)),
    );

    await processJob(await jobFor(docId), { embedder: fakeEmbedder({ count: 0 }) });
    const after = await withTenant(org, (tx) =>
      tx.select().from(documentChunks).where(eq(documentChunks.documentId, docId)),
    );
    expect(after).toHaveLength(before.length);
  });

  it('marks the document failed when embedding blows up', async () => {
    const docId = await seedDocument('Content that will fail to embed.');
    const job = await jobFor(docId);
    const broken: Embedder = {
      embedDocuments: async () => { throw new Error('provider exploded'); },
      embedQuery: async () => [],
    };

    await expect(processJob(job, { embedder: broken })).rejects.toThrow(/provider exploded/);

    const [doc] = await withTenant(org, (tx) =>
      tx.select().from(documents).where(eq(documents.id, docId)),
    );
    expect(doc?.status).toBe('failed');
    expect(doc?.errorMessage).toMatch(/provider exploded/);
  });
});
