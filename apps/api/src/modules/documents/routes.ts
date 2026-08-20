import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../db/with-tenant.ts';
import { documentChunks, documents, ingestionJobs } from '../../db/schema/index.ts';
import { requireOrg } from '../../auth/guard.ts';
import { contentHash, parseByType, type SourceType } from '../ingestion/parsers/index.ts';
import { enqueueJob } from '../ingestion/queue.ts';
import type { Worker } from '../ingestion/worker.ts';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const pasteSchema = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1),
});

const EXT_TO_TYPE: Record<string, SourceType> = {
  pdf: 'pdf', txt: 'txt', md: 'md', markdown: 'md',
};

export function documentRoutes(worker: Worker) {
  return async function routes(app: FastifyInstance) {
    app.addHook('preHandler', requireOrg);

    /** Paste raw text. */
    app.post('/v1/documents/text', async (req, reply) => {
      const body = pasteSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });

      const parsed = await parseByType('paste', body.data.text);
      const created = await createDocument(req.orgId!, {
        title: body.data.title, sourceType: 'paste', parsed,
      });
      worker.notify();
      return reply.code(created.duplicate ? 200 : 201).send(created);
    });

    /** Upload a PDF, .txt or .md file. */
    app.post('/v1/documents', async (req, reply) => {
      const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
      if (!file) return reply.code(400).send({ error: 'expected a file upload' });

      const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
      const sourceType = EXT_TO_TYPE[ext];
      if (!sourceType) {
        return reply.code(415).send({ error: `unsupported file type: .${ext}`, supported: ['pdf', 'txt', 'md'] });
      }

      const buffer = await file.toBuffer().catch(() => null);
      if (!buffer) {
        return reply.code(413).send({ error: `file exceeds ${MAX_UPLOAD_BYTES} bytes` });
      }

      const parsed = await parseByType(sourceType, new Uint8Array(buffer));
      if (!parsed.text.trim()) {
        return reply.code(422).send({ error: 'no extractable text found in this file' });
      }

      const created = await createDocument(req.orgId!, {
        title: file.filename, sourceType, parsed, byteSize: buffer.length,
      });
      worker.notify();
      return reply.code(created.duplicate ? 200 : 201).send(created);
    });

    /** Library listing with live ingestion status. */
    app.get('/v1/documents', async (req) =>
      withTenant(req.orgId!, (tx) =>
        tx.select({
          id: documents.id,
          title: documents.title,
          sourceType: documents.sourceType,
          status: documents.status,
          chunkCount: documents.chunkCount,
          tokenCount: documents.tokenCount,
          pageCount: documents.pageCount,
          byteSize: documents.byteSize,
          errorMessage: documents.errorMessage,
          createdAt: documents.createdAt,
        }).from(documents).orderBy(desc(documents.createdAt)),
      ),
    );

    /** Progress for the upload spinner. */
    app.get('/v1/documents/:id/status', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = await withTenant(req.orgId!, async (tx) => {
        const [doc] = await tx.select().from(documents).where(eq(documents.id, id));
        if (!doc) return null;
        const [job] = await tx.select().from(ingestionJobs)
          .where(eq(ingestionJobs.documentId, id))
          .orderBy(desc(ingestionJobs.createdAt)).limit(1);
        return {
          status: doc.status,
          chunkCount: doc.chunkCount,
          errorMessage: doc.errorMessage,
          job: job && {
            state: job.state, stage: job.stage,
            progressPct: job.progressPct, attempts: job.attempts,
            lastError: job.lastError,
          },
        };
      });
      return row ? reply.send(row) : reply.code(404).send({ error: 'document not found' });
    });

    app.get('/v1/documents/:id/chunks', async (req) => {
      const { id } = req.params as { id: string };
      return withTenant(req.orgId!, (tx) =>
        tx.select({
          chunkIndex: documentChunks.chunkIndex,
          content: documentChunks.content,
          headingPath: documentChunks.headingPath,
          pageFrom: documentChunks.pageFrom,
          pageTo: documentChunks.pageTo,
          tokenCount: documentChunks.tokenCount,
        }).from(documentChunks)
          .where(eq(documentChunks.documentId, id))
          .orderBy(documentChunks.chunkIndex),
      );
    });

    /** Re-chunk and re-embed from the stored text; no re-upload needed. */
    app.post('/v1/documents/:id/reembed', async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await withTenant(req.orgId!, async (tx) => {
        const [doc] = await tx.select().from(documents).where(eq(documents.id, id));
        if (!doc) return false;
        await tx.update(documents).set({ status: 'pending' }).where(eq(documents.id, id));
        return true;
      });
      if (!ok) return reply.code(404).send({ error: 'document not found' });

      await enqueueJob(req.orgId!, id);
      worker.notify();
      return reply.code(202).send({ id, status: 'pending' });
    });

    app.delete('/v1/documents/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      // Chunks and jobs cascade, so vectors can never outlive their document.
      const deleted = await withTenant(req.orgId!, (tx) =>
        tx.delete(documents)
          .where(and(eq(documents.id, id), eq(documents.orgId, req.orgId!)))
          .returning({ id: documents.id }),
      );
      return deleted.length
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'document not found' });
    });
  };
}

interface CreateArgs {
  title: string;
  sourceType: SourceType;
  parsed: { text: string; pageCount?: number; pageBreaks?: number[] };
  byteSize?: number;
}

async function createDocument(orgId: string, args: CreateArgs) {
  const hash = contentHash(args.parsed.text);

  return withTenant(orgId, async (tx) => {
    // Same content twice costs nothing: the unique index on (org_id, content_hash)
    // is the cheapest cost control we have.
    const [existing] = await tx.select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(and(eq(documents.orgId, orgId), eq(documents.contentHash, hash)));
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };

    const [doc] = await tx.insert(documents).values({
      orgId,
      title: args.title,
      sourceType: args.sourceType,
      contentHash: hash,
      byteSize: args.byteSize,
      pageCount: args.parsed.pageCount,
      extractedText: args.parsed.text,
      pageBreaks: args.parsed.pageBreaks,
      status: 'pending',
    }).returning({ id: documents.id });

    await tx.insert(ingestionJobs).values({ orgId, documentId: doc!.id, state: 'queued' });
    return { id: doc!.id, status: 'pending', duplicate: false };
  });
}
