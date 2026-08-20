/**
 * gemini-embedding-001 returns UNNORMALIZED vectors at any output dimension
 * other than 3072. We request 768, so normalizing is a correctness requirement,
 * not an optimization: skip it and cosine similarity silently returns subtly
 * wrong rankings — retrieval that "sort of works", which is worse than retrieval
 * that fails loudly.
 */
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const magnitude = Math.sqrt(sumSquares);
  // A zero vector has no direction; dividing would yield NaN, and a NaN vector
  // poisons every comparison it takes part in.
  if (magnitude === 0) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}
