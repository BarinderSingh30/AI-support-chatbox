import type { FastifyInstance } from 'fastify';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.ts';

/**
 * Better Auth reads the raw Node request stream itself. Fastify's default JSON
 * parser drains that stream first, so the handler would see an empty body.
 *
 * Registering inside a plugin gives us an encapsulated content-type parser: the
 * pass-through applies only to /api/auth/*, and every other route keeps normal
 * JSON parsing.
 */
export async function authPlugin(app: FastifyInstance) {
  app.removeContentTypeParser(['application/json', 'text/plain']);
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.all('/api/auth/*', async (req, reply) => {
    reply.hijack();
    await toNodeHandler(auth)(req.raw, reply.raw);
  });
}
