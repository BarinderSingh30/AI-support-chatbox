export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * USD per million tokens, verified against Google's pricing page on 2026-08-20.
 *
 * Kept as data rather than scattered constants so a price change is a one-line
 * edit, and so the dashboard can show real spend instead of a guess.
 */
export const PRICING: Record<string, ModelPrice> = {
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  // Introductory rate through 2026-12-31; list price doubles on 2027-01-01.
  'gemini-3.7-flash': { inputPerMillion: 0.75, outputPerMillion: 3.75 },
  'gemini-embedding-001': { inputPerMillion: 0.15, outputPerMillion: 0 },
};

export interface Usage {
  inputTokens: number;
  outputTokens?: number;
}

export function estimateCost(model: string, usage: Usage): number {
  const price = PRICING[model] ?? {
    // An unknown model is priced at the dearest known rate. Guessing low would
    // understate spend and quietly defeat the per-tenant caps.
    inputPerMillion: Math.max(...Object.values(PRICING).map((p) => p.inputPerMillion)),
    outputPerMillion: Math.max(...Object.values(PRICING).map((p) => p.outputPerMillion)),
  };

  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion
  );
}
