import { describe, expect, it } from 'vitest';
import { createGeminiEmbedder } from '../src/modules/ingestion/embedder.ts';
import { cosineSimilarity } from '../src/modules/ingestion/vectors.ts';
import { env } from '../src/env.ts';

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/**
 * Hits the real Gemini API. Skipped automatically when no key is configured, so
 * the suite still runs offline and in CI without secrets — but the API contract
 * (dimensions, batching, task types) is verified for real when a key exists.
 */
describe.skipIf(!env.GEMINI_API_KEY)('gemini embeddings (live)', () => {
  const embedder = createGeminiEmbedder();

  it('returns 768-dimensional vectors for documents', async () => {
    const vectors = await embedder.embedDocuments([
      'Acme robots carry a 24-month limited warranty.',
      'Shipping is free on orders over fifty dollars.',
    ]);
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      expect(v).toHaveLength(768);
      // The model does not normalize below 3072 dimensions; we must.
      expect(norm(v)).toBeCloseTo(1, 5);
    }
  }, 30_000);

  it('returns a 768-dimensional normalized query vector', async () => {
    const v = await embedder.embedQuery('How long is the warranty?');
    expect(v).toHaveLength(768);
    expect(norm(v)).toBeCloseTo(1, 5);
  }, 30_000);

  it('ranks the semantically relevant document above an irrelevant one', async () => {
    // The actual proof that retrieval will work: asymmetric task types placing
    // query and documents in a comparable space, with real semantics.
    const [warranty, shipping] = await embedder.embedDocuments([
      'All Acme robots carry a 24-month limited warranty covering parts and labour.',
      'Orders over fifty dollars ship free within the continental United States.',
    ]);
    const query = await embedder.embedQuery('how long am I covered if my robot breaks?');

    const warrantyScore = cosineSimilarity(query, warranty!);
    const shippingScore = cosineSimilarity(query, shipping!);

    expect(warrantyScore).toBeGreaterThan(shippingScore);
  }, 30_000);
});
