import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../../auth/guard.ts';
import { getConversation, listConversations } from './service.ts';

function parseListQuery(query: unknown): { limit: number; offset: number } {
  const q = query as { limit?: string; offset?: string };
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { limit, offset };
}

/** Admin-side conversation browser: session-authenticated, tenant-scoped, read-only. */
export async function conversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.get('/v1/conversations', async (req) => {
    const { limit, offset } = parseListQuery(req.query);
    return listConversations(req.orgId!, limit, offset);
  });

  app.get('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const messages = await getConversation(req.orgId!, id);
    return messages
      ? reply.send({ id, messages })
      : reply.code(404).send({ error: 'conversation not found' });
  });
}
