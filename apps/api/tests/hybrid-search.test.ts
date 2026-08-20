import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { documentChunks, documents, organization } from '../src/db/schema/index.ts';
import { hybridSearch } from '../src/modules/retrieval/hybrid-search.ts';

const orgA = `h-a-${randomUUID()}`;
const orgB = `h-b-${randomUUID()}`;

/** Unit vector pointing along one axis, so cosine distance is predictable. */
const axis = (i: number) => Array.from({ length: 768 }, (_, n) => (n === i ? 1 : 0));

async function seed(orgId: string, rows: Array<{ content: string; heading: string; axis: number }>) {
  return withTenant(orgId, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      orgId, title: 'Handbook', sourceType: 'md', contentHash: randomUUID(), status: 'ready',
    }).returning();
    await tx.insert(documentChunks).values(
      rows.map((r, i) => ({
        orgId, documentId: doc!.id, chunkIndex: i,
        content: r.content, headingPath: r.heading,
        pageFrom: i + 1, pageTo: i + 1, tokenCount: 20,
        embedding: axis(r.axis),
      })),
    );
    return doc!.id;
  });
}

beforeAll(async () => {
  for (const id of [orgA, orgB]) {
    await db.delete(organization).where(eq(organization.id, id));
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
  }
  await seed(orgA, [
    { content: 'Refunds are issued within fourteen days of the returned unit arriving.', heading: 'Refunds', axis: 0 },
    { content: 'Replacement part SKU-4471 is the dock contact plate for model R2.', heading: 'Parts', axis: 1 },
    { content: 'Shipping is free on orders over fifty dollars.', heading: 'Shipping', axis: 2 },
  ]);
  await seed(orgB, [
    { content: 'Globex refunds are issued within thirty days instead.', heading: 'Refunds', axis: 0 },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgA));
  await db.delete(organization).where(eq(organization.id, orgB));
  await pool.end();
});

describe('hybridSearch', () => {
  it('returns the vector-nearest chunk first when only semantics match', async () => {
    const results = await hybridSearch(orgA, {
      queryVector: axis(0), queryText: 'money back timeline', topK: 3,
    });
    expect(results[0]?.content).toContain('Refunds are issued');
    expect(results[0]?.similarity).toBeCloseTo(1, 5);
  });

  it('finds an exact token the vector search would blur away', async () => {
    // Product codes are the classic failure of pure vector search, and exactly
    // what support questions contain.
    const results = await hybridSearch(orgA, {
      queryVector: axis(2), queryText: 'SKU-4471', topK: 3,
    });
    expect(results.some((r) => r.content.includes('SKU-4471'))).toBe(true);
  });

  it('reports which strategies found each chunk', async () => {
    const results = await hybridSearch(orgA, {
      queryVector: axis(1), queryText: 'SKU-4471', topK: 3,
    });
    const sku = results.find((r) => r.content.includes('SKU-4471'));
    expect(sku?.matchedVector).toBe(true);
    expect(sku?.matchedKeyword).toBe(true);
  });

  it('honours topK', async () => {
    const results = await hybridSearch(orgA, {
      queryVector: axis(0), queryText: 'refunds shipping parts', topK: 2,
    });
    expect(results).toHaveLength(2);
  });

  it('carries the citation metadata an answer needs', async () => {
    const [top] = await hybridSearch(orgA, {
      queryVector: axis(0), queryText: 'refunds', topK: 1,
    });
    expect(top?.headingPath).toBe('Refunds');
    expect(top?.documentTitle).toBe('Handbook');
    expect(top?.pageFrom).toBe(1);
  });

  it('never returns another tenant chunks', async () => {
    const results = await hybridSearch(orgA, {
      queryVector: axis(0), queryText: 'refunds', topK: 10,
    });
    expect(results.every((r) => !r.content.includes('Globex'))).toBe(true);
  });

  it('returns nothing for a tenant with no documents', async () => {
    const empty = `h-empty-${randomUUID()}`;
    await db.insert(organization).values({ id: empty, name: empty, slug: empty, createdAt: new Date() });
    const results = await hybridSearch(empty, {
      queryVector: axis(0), queryText: 'anything at all', topK: 5,
    });
    expect(results).toEqual([]);
    await db.delete(organization).where(eq(organization.id, empty));
  });
});
