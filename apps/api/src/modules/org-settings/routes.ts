import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../../auth/guard.ts';
import { getOrgSettings, upsertOrgSettings } from './service.ts';

const updateSchema = z.object({
  welcomeMessage: z.string().min(1).max(2000).optional(),
  suggestedQuestions: z.array(z.string().min(1).max(300)).max(10).optional(),
  // .nullable(): the dashboard's widget configurator (Task 12) sends the full
  // settings object on every save, and an org with no system prompt set has
  // this as `null` (see GET's default) — not merely absent from the body.
  // Without .nullable() here, every save from a fresh org fails validation.
  systemPrompt: z.string().max(4000).nullable().optional(),
  noAnswerMessage: z.string().min(1).max(2000).optional(),
  minScore: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(20).optional(),
});

/** Admin-side widget configurator backing store: session-authenticated, tenant-scoped. */
export async function orgSettingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.get('/v1/org-settings', async (req) => getOrgSettings(req.orgId!));

  app.put('/v1/org-settings', async (req, reply) => {
    const body = updateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    return upsertOrgSettings(req.orgId!, body.data);
  });
}
