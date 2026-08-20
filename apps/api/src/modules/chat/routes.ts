import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../db/with-tenant.ts';
import { chatMessages, chatSessions, messageCitations, documentChunks } from '../../db/schema/index.ts';
import { requireOrg } from '../../auth/guard.ts';
import { answerQuestion, type AnswerDeps } from './answer.ts';

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

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer streamed responses by default, which would
        // defeat the point of streaming.
        'x-accel-buffering': 'no',
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const gen = answerQuestion({
          orgId: req.orgId!,
          question: parsed.data.question,
          sessionId: parsed.data.sessionId,
          userAgent: req.headers['user-agent'],
          deps,
        });

        let next = await gen.next();
        while (!next.done) {
          if (next.value.type === 'token') send('token', { text: next.value.text });
          else send('citations', { citations: next.value.citations });
          next = await gen.next();
        }
        send('done', {
          sessionId: next.value.sessionId,
          messageId: next.value.messageId,
          answered: next.value.answered,
          topScore: next.value.topScore,
          latencyMs: next.value.latencyMs,
          costUsd: Number(next.value.costUsd.toFixed(6)),
        });
      } catch (error) {
        req.log.error({ err: error }, 'chat stream failed');
        send('error', { error: 'answer generation failed' });
      } finally {
        reply.raw.end();
      }
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
