import { describe, expect, it } from 'vitest';
import { embedInBatches } from '../src/modules/ingestion/embedder.ts';

/**
 * Encodes the source string's length in the vector's DIRECTION, not its
 * magnitude — normalization discards magnitude, so [n*3, n*4, 0] would collapse
 * to the same unit vector for every n and prove nothing about ordering.
 */
const fakeEmbed = (calls: string[][]) => async (batch: string[]) => {
  calls.push(batch);
  return batch.map((t) => [t.length, 1, 0]);
};

describe('embedInBatches', () => {
  it('splits input into batches of the configured size', async () => {
    const calls: string[][] = [];
    await embedInBatches(['a', 'b', 'c', 'd', 'e'], 2, fakeEmbed(calls));
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('preserves input order across batch boundaries', async () => {
    const calls: string[][] = [];
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
    const out = await embedInBatches(texts, 2, fakeEmbed(calls));
    // v[0]/v[1] survives normalization and recovers the source length.
    expect(out.map((v) => Math.round(v[0]! / v[1]!))).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalizes every vector it returns', async () => {
    const out = await embedInBatches(['a', 'bb'], 10, fakeEmbed([]));
    for (const v of out) {
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 10);
    }
  });

  it('makes no API call for empty input', async () => {
    const calls: string[][] = [];
    const out = await embedInBatches([], 10, fakeEmbed(calls));
    expect(calls).toHaveLength(0);
    expect(out).toEqual([]);
  });

  it('fails loudly when the provider returns the wrong number of vectors', async () => {
    // Silently accepting this would misalign every chunk with its embedding —
    // the worst possible failure, because retrieval still "works".
    await expect(
      embedInBatches(['a', 'b'], 10, async () => [[1, 0, 0]]),
    ).rejects.toThrow(/expected 2 embeddings, got 1/i);
  });
});
