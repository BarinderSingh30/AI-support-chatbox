import { describe, expect, it } from 'vitest';
import { l2Normalize, cosineSimilarity } from '../src/modules/ingestion/vectors.ts';

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    expect(norm(l2Normalize([3, 4]))).toBeCloseTo(1, 10);
  });

  it('preserves direction', () => {
    const [x, y] = l2Normalize([3, 4]) as [number, number];
    expect(x).toBeCloseTo(0.6, 10);
    expect(y).toBeCloseTo(0.8, 10);
  });

  it('leaves an already-normalized vector unchanged', () => {
    expect(norm(l2Normalize([1, 0, 0]))).toBeCloseTo(1, 10);
  });

  it('returns zeros rather than NaN for a zero vector', () => {
    // Guarding this matters: a NaN vector poisons every cosine comparison it
    // touches, and pgvector will happily store it.
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('cosineSimilarity', () => {
  it('scores identical vectors as 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('scores opposite vectors as -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
});
