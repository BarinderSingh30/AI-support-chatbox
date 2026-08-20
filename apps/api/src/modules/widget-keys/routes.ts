import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../../auth/guard.ts';
import { createWidgetKey, listWidgetKeys, revokeWidgetKey } from './service.ts';

const createSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  allowedOrigins: z.array(z.string().url()).min(1),
  rateLimitRpm: z.number().int().positive().max(1000).optional(),
  monthlyMsgCap: z.number().int().positive().optional(),
});

/** Admin-side widget key management: session-authenticated, tenant-scoped. */
export async function widgetKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.post('/v1/widget-keys', async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    const key = await createWidgetKey(req.orgId!, body.data);
    return reply.code(201).send(key);
  });

  app.get('/v1/widget-keys', async (req) => listWidgetKeys(req.orgId!));

  app.delete('/v1/widget-keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await revokeWidgetKey(req.orgId!, id);
      return reply.code(204).send();
    } catch {
      return reply.code(404).send({ error: 'widget key not found' });
    }
  });
}
