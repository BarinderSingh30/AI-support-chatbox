import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../src/modules/retrieval/rrf.ts';

describe('reciprocalRankFusion', () => {
  it('ranks an item appearing high in both lists above one high in only a single list', () => {
    // The whole point of fusion: agreement between two different retrieval
    // strategies is stronger evidence than a top hit in either one alone.
    const fused = reciprocalRankFusion([
      [{ id: 'both' }, { id: 'vectorOnly' }],
      [{ id: 'both' }, { id: 'keywordOnly' }],
    ]);
    expect(fused[0]?.id).toBe('both');
  });

  it('includes items that appear in only one list', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'b' }]]);
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('scores by reciprocal rank with the damping constant', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }]], 60);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 10);
  });

  it('sums contributions across lists', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'a' }]], 60);
    expect(fused[0]?.score).toBeCloseTo(2 / 61, 10);
  });

  it('returns results in descending score order', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
      [{ id: 'z' }, { id: 'y' }],
    ]);
    const scores = fused.map((f) => f.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('handles empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('lets a lower damping constant sharpen the influence of top ranks', () => {
    const lists = [[{ id: 'a' }, { id: 'b' }]];
    const sharp = reciprocalRankFusion(lists, 1);
    const flat = reciprocalRankFusion(lists, 1000);
    const sharpGap = sharp[0]!.score - sharp[1]!.score;
    const flatGap = flat[0]!.score - flat[1]!.score;
    expect(sharpGap).toBeGreaterThan(flatGap);
  });
});
