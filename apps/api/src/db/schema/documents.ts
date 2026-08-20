import {
  pgTable, text, integer, timestamp, index, uniqueIndex, vector, jsonb, customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organization } from './auth.ts';

/** Postgres full-text search vector; Drizzle has no first-class tsvector type. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

const orgId = () =>
  text('org_id').notNull().references(() => organization.id, { onDelete: 'cascade' });

export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    orgId: orgId(),
    title: text('title').notNull(),
    sourceType: text('source_type').notNull(), // pdf | txt | md | paste | url
    sourceUri: text('source_uri'),
    contentHash: text('content_hash').notNull(),
    byteSize: integer('byte_size'),
    pageCount: integer('page_count'),
    status: text('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    chunkCount: integer('chunk_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
    embeddingModel: text('embedding_model'),
    // Parsed text is kept so a document can be re-chunked or re-embedded without
    // re-uploading the original. Costs storage; buys migration ability when the
    // chunking strategy or embedding model changes.
    extractedText: text('extracted_text'),
    // Character offset where each PDF page begins, for page-numbered citations.
    pageBreaks: jsonb('page_breaks').$type<number[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Re-uploading the same file must not cost a second round of embeddings.
    uniqueIndex('documents_org_hash_uniq').on(t.orgId, t.contentHash),
    index('documents_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    // Denormalized so RLS policies need no join.
    orgId: orgId(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    headingPath: text('heading_path'),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    tokenCount: integer('token_count'),
    // 768, not the model default of 3072: pgvector's HNSW index caps `vector`
    // at 2000 dimensions. Values are L2-normalized at write time.
    embedding: vector('embedding', { dimensions: 768 }),
    // Keyword half of hybrid search. Vectors are fuzzy by nature and lose exact
    // tokens — error codes, SKUs, product names — which is precisely what
    // support questions are full of. The heading is included so a section title
    // is matchable even when the body never repeats it.
    fts: tsvector('fts').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(heading_path, '') || ' ' || content)`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('chunks_fts_gin_idx').using('gin', t.fts),
    index('chunks_doc_idx').on(t.orgId, t.documentId, t.chunkIndex),
  ],
);

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    orgId: orgId(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('queued'),
    stage: text('stage'),
    progressPct: integer('progress_pct').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('jobs_state_idx').on(t.state, t.lockedAt)],
);
