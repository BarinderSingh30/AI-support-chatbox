import { GoogleGenAI } from '@google/genai';
import { env } from '../../env.ts';
import { l2Normalize } from './vectors.ts';

export type RawEmbed = (batch: string[]) => Promise<number[][]>;

export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** Conservative: keeps request bodies small enough to retry cheaply. */
export const DEFAULT_BATCH_SIZE = 32;

/**
 * Batches embedding calls and normalizes every result.
 *
 * The provider call is injected so this — the part with the ordering and
 * alignment risk — is testable without a network or an API key.
 */
export async function embedInBatches(
  texts: string[],
  batchSize: number,
  rawEmbed: RawEmbed,
): Promise<number[][]> {
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await rawEmbed(batch);
    // A short response would silently pair chunk N with chunk N+1's vector for
    // the rest of the document. Retrieval would still return results, just
    // subtly wrong ones — so this must be fatal, not warned about.
    if (vectors.length !== batch.length) {
      throw new Error(`expected ${batch.length} embeddings, got ${vectors.length}`);
    }
    for (const vector of vectors) out.push(l2Normalize(vector));
  }

  return out;
}

export function createGeminiEmbedder(apiKey = env.GEMINI_API_KEY): Embedder {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const ai = new GoogleGenAI({ apiKey });

  const call = (taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): RawEmbed =>
    async (batch) => {
      const res = await ai.models.embedContent({
        model: env.EMBEDDING_MODEL,
        contents: batch,
        config: {
          taskType,
          // 768 rather than the 3072 default: pgvector's HNSW index cannot hold
          // a `vector` above 2000 dimensions.
          outputDimensionality: env.EMBEDDING_DIMENSIONS,
        },
      });
      return (res.embeddings ?? []).map((e) => e.values ?? []);
    };

  return {
    // Asymmetric task types are the point of this model: documents and queries
    // are embedded into the same space but optimized for their role.
    embedDocuments: (texts) =>
      embedInBatches(texts, DEFAULT_BATCH_SIZE, call('RETRIEVAL_DOCUMENT')),
    embedQuery: async (text) => {
      const [vector] = await embedInBatches([text], 1, call('RETRIEVAL_QUERY'));
      if (!vector) throw new Error('embedding provider returned no vector for query');
      return vector;
    },
  };
}

/**
 * Defers provider construction until the first embedding call.
 *
 * Without this, a missing GEMINI_API_KEY would stop the whole server from
 * booting — including the dashboard and document library, which do not need it.
 * Ingestion still fails loudly, but only ingestion.
 */
export function createLazyEmbedder(factory: () => Embedder): Embedder {
  let inner: Embedder | null = null;
  const get = () => (inner ??= factory());
  return {
    embedDocuments: (texts) => get().embedDocuments(texts),
    embedQuery: (text) => get().embedQuery(text),
  };
}
