import { describe, expect, it } from 'vitest';
import { estimateCost, PRICING } from '../src/llm/cost.ts';

describe('estimateCost', () => {
  it('prices chat input and output at their different rates', () => {
    // 1M input + 1M output on gemini-2.5-flash = 0.30 + 2.50
    const cost = estimateCost('gemini-2.5-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(2.8, 6);
  });

  it('prices a realistic single answer in fractions of a cent', () => {
    const cost = estimateCost('gemini-2.5-flash', { inputTokens: 2_000, outputTokens: 200 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it('prices embeddings as input-only', () => {
    expect(estimateCost('gemini-embedding-001', { inputTokens: 1_000_000 })).toBeCloseTo(0.15, 6);
  });

  it('returns zero for zero usage', () => {
    expect(estimateCost('gemini-2.5-flash', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('falls back to the most expensive known rate for an unknown model', () => {
    // Guessing low would understate spend and defeat the point of the caps.
    const unknown = estimateCost('some-future-model', { inputTokens: 1_000_000, outputTokens: 0 });
    const dearest = Math.max(...Object.values(PRICING).map((p) => p.inputPerMillion));
    expect(unknown).toBeCloseTo(dearest, 6);
  });
});
