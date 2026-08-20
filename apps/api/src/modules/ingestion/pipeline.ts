import { eq } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import { documentChunks, documents } from '../../db/schema/index.ts';
import { env } from '../../env.ts';
import { chunkDocument } from './chunker.ts';
import { assignPages } from './pages.ts';
import type { Embedder } from './embedder.ts';
import { updateProgress, type ClaimedJob } from './queue.ts';

export interface PipelineDeps {
  embedder: Embedder;
}

/**
 * Parse -> chunk -> embed -> store, for one claimed job.
 *
 * Runs inside the job's own tenant scope: the worker's cross-tenant reach stops
 * at the queue, and every document and chunk write here goes through withTenant.
 */
export async function processJob(job: ClaimedJob, deps: PipelineDeps): Promise<void> {
  try {
    const doc = await withTenant(job.orgId, async (tx) => {
      const [row] = await tx.select().from(documents).where(eq(documents.id, job.documentId));
      return row;
    });
    if (!doc) throw new Error(`document ${job.documentId} not found`);
    if (!doc.extractedText) throw new Error(`document ${job.documentId} has no extracted text`);

    await updateProgress(job.id, 'chunking', 10);
    const chunks = chunkDocument(doc.extractedText);
    if (chunks.length === 0) throw new Error('document produced no chunks');

    const pages = assignPages(chunks, doc.pageBreaks ?? undefined);

    await updateProgress(job.id, 'embedding', 30);
    const vectors = await deps.embedder.embedDocuments(chunks.map((c) => c.content));

    await updateProgress(job.id, 'storing', 80);
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);

    await withTenant(job.orgId, async (tx) => {
      // Delete-then-insert in one transaction, so a re-run replaces rather than
      // duplicates, and a failure leaves the previous chunks intact.
      await tx.delete(documentChunks).where(eq(documentChunks.documentId, doc.id));
      await tx.insert(documentChunks).values(
        chunks.map((chunk, i) => ({
          orgId: job.orgId,
          documentId: doc.id,
          chunkIndex: chunk.index,
          content: chunk.content,
          headingPath: chunk.headingPath,
          pageFrom: pages[i]!.pageFrom,
          pageTo: pages[i]!.pageTo,
          tokenCount: chunk.tokenCount,
          embedding: vectors[i]!,
        })),
      );
      await tx.update(documents).set({
        status: 'ready',
        chunkCount: chunks.length,
        tokenCount: totalTokens,
        embeddingModel: env.EMBEDDING_MODEL,
        errorMessage: null,
        updatedAt: new Date(),
      }).where(eq(documents.id, doc.id));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTenant(job.orgId, (tx) =>
      tx.update(documents)
        .set({ status: 'failed', errorMessage: message.slice(0, 2000), updatedAt: new Date() })
        .where(eq(documents.id, job.documentId)),
    ).catch(() => {});
    throw error;
  }
}
