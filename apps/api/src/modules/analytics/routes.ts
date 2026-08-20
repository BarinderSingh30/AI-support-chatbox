import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../../auth/guard.ts';
import { getAnalyticsOverview, getUnansweredQuestions } from './service.ts';

function parseDays(query: unknown): number {
  const q = query as { days?: string };
  const days = Number(q.days) || 30;
  return Math.min(Math.max(days, 1), 365);
}

/** Admin-side analytics: session-authenticated, tenant-scoped, read-only. */
export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.get('/v1/analytics/overview', async (req) =>
    getAnalyticsOverview(req.orgId!, parseDays(req.query)));

  app.get('/v1/analytics/unanswered', async (req) => {
    const days = parseDays(req.query);
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    return getUnansweredQuestions(req.orgId!, days, limit);
  });
}
