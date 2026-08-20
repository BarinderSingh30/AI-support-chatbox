import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../db/with-tenant.ts';
import { chatMessages, chatSessions, messageCitations, documentChunks } from '../../db/schema/index.ts';
import { requireOrg } from '../../auth/guard.ts';
import type { AnswerDeps } from './answer.ts';
import { streamAnswer } from './stream.ts';

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  sessionId: z.string().optional(),
});

export function chatRoutes(deps: AnswerDeps) {
  return async function routes(app: FastifyInstance) {
    app.addHook('preHandler', requireOrg);

    /**
     * Server-sent events, one JSON object per event.
     *
     * SSE rather than websockets: the traffic is one-directional, it survives
     * proxies that mangle upgrades, and the browser reconnects on its own.
     */
    app.post('/v1/chat', async (req, reply) => {
      const parsed = askSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

      await streamAnswer(reply, {
        orgId: req.orgId!,
        question: parsed.data.question,
        sessionId: parsed.data.sessionId,
        userAgent: req.headers['user-agent'],
        deps,
      });
    });

        /** Transcript with the passages each answer actually used. */
    app.get('/v1/chat/sessions/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = await withTenant(req.orgId!, async (tx) => {
        const [session] = await tx.select().from(chatSessions)
          .where(and(eq(chatSessions.id, id), eq(chatSessions.orgId, req.orgId!)));
        if (!session) return null;

        const messages = await tx.select().from(chatMessages)
          .where(eq(chatMessages.sessionId, id))
          .orderBy(chatMessages.createdAt);

        const cites = await tx.select({
          messageId: messageCitations.messageId,
          rank: messageCitations.rank,
          score: messageCitations.score,
          content: documentChunks.content,
          headingPath: documentChunks.headingPath,
          pageFrom: documentChunks.pageFrom,
        }).from(messageCitations)
          .innerJoin(documentChunks, eq(documentChunks.id, messageCitations.chunkId));

        return {
          session,
          messages: messages.map((m) => ({
            ...m,
            citations: cites.filter((c) => c.messageId === m.id).sort((a, b) => a.rank - b.rank),
          })),
        };
      });
      return data ? reply.send(data) : reply.code(404).send({ error: 'session not found' });
    });

    app.get('/v1/chat/sessions', async (req) =>
      withTenant(req.orgId!, (tx) =>
        tx.select().from(chatSessions).orderBy(desc(chatSessions.startedAt)).limit(100),
      ),
    );
  };
}
