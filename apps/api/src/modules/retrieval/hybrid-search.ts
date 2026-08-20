import { sql } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import { reciprocalRankFusion } from './rrf.ts';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  /** Cosine similarity to the query, 0..1. Drives the relevance gate. */
  similarity: number;
  /** Fused rank score. Not comparable to similarity — position, not distance. */
  score: number;
  matchedVector: boolean;
  matchedKeyword: boolean;
}

export interface HybridSearchParams {
  queryVector: number[];
  queryText: string;
  topK: number;
  /** How many candidates each strategy contributes before fusion. */
  candidatePool?: number;
}

interface CandidateRow {
  id: string;
  document_id: string;
  document_title: string;
  content: string;
  heading_path: string | null;
  page_from: number | null;
  page_to: number | null;
  similarity: number;
  vector_rank: number | null;
  keyword_rank: number | null;
}

/**
 * Semantic and keyword retrieval, fused.
 *
 * Both halves run in one round trip as CTEs; fusion happens in JS because
 * cosine distance and ts_rank are not on comparable scales, and RRF only needs
 * their positions. Tenant scoping is not in the WHERE clause on purpose — RLS
 * applies it, so a bug here cannot leak across tenants.
 */
export async function hybridSearch(
  orgId: string,
  params: HybridSearchParams,
): Promise<RetrievedChunk[]> {
  const pool = params.candidatePool ?? Math.max(params.topK * 4, 20);
  const vectorLiteral = `[${params.queryVector.join(',')}]`;

  const rows = await withTenant(orgId, async (tx) => {
    const result = await tx.execute(sql`
      WITH vector_hits AS (
        SELECT id,
               row_number() OVER (ORDER BY embedding <=> ${vectorLiteral}::vector) AS rank,
               1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM document_chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${pool}
      ),
      query AS (SELECT plainto_tsquery('english', ${params.queryText}) AS q),
      keyword_hits AS (
        SELECT c.id,
               row_number() OVER (ORDER BY ts_rank_cd(c.fts, query.q) DESC) AS rank
        FROM document_chunks c, query
        WHERE c.fts @@ query.q
        ORDER BY ts_rank_cd(c.fts, query.q) DESC
        LIMIT ${pool}
      ),
      candidates AS (
        SELECT id FROM vector_hits
        UNION
        SELECT id FROM keyword_hits
      )
      SELECT c.id,
             c.document_id,
             d.title AS document_title,
             c.content,
             c.heading_path,
             c.page_from,
             c.page_to,
             COALESCE(v.similarity, 1 - (c.embedding <=> ${vectorLiteral}::vector)) AS similarity,
             v.rank AS vector_rank,
             k.rank AS keyword_rank
      FROM candidates
      JOIN document_chunks c ON c.id = candidates.id
      JOIN documents d ON d.id = c.document_id
      LEFT JOIN vector_hits v ON v.id = candidates.id
      LEFT JOIN keyword_hits k ON k.id = candidates.id
    `);
    return (result.rows ?? result) as unknown as CandidateRow[];
  });

  if (rows.length === 0) return [];

  const byRank = (key: 'vector_rank' | 'keyword_rank') =>
    rows
      .filter((r) => r[key] !== null)
      .sort((a, b) => Number(a[key]) - Number(b[key]))
      .map((r) => ({ id: r.id }));

  const fused = reciprocalRankFusion([byRank('vector_rank'), byRank('keyword_rank')]);
  const index = new Map(rows.map((r) => [r.id, r]));

  return fused.slice(0, params.topK).map((hit) => {
    const row = index.get(hit.id)!;
    return {
      id: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      content: row.content,
      headingPath: row.heading_path,
      pageFrom: row.page_from,
      pageTo: row.page_to,
      similarity: Number(row.similarity),
      score: hit.score,
      matchedVector: row.vector_rank !== null,
      matchedKeyword: row.keyword_rank !== null,
    };
  });
}
