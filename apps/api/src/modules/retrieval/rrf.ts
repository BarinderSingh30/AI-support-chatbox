export interface Ranked {
  id: string;
}

export interface FusedResult {
  id: string;
  score: number;
}

/** Standard damping constant from the original RRF paper. */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion.
 *
 * Combines several ranked lists without needing their scores to be comparable —
 * which matters here because cosine similarity and ts_rank live on completely
 * different scales and normalizing between them is guesswork. RRF only looks at
 * position, so a chunk that both strategies rank highly beats one that either
 * strategy loves alone.
 *
 * The constant k damps the advantage of the very top ranks; smaller k makes
 * first place count for proportionally more.
 */
export function reciprocalRankFusion(lists: Ranked[][], k: number = RRF_K): FusedResult[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank));
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
