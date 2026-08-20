import type { FastifyInstance } from 'fastify';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.ts';
import { env } from '../env.ts';

/** Same allowlist @fastify/cors is given for this group — see app.ts. */
const ALLOWED_ORIGINS = [env.BETTER_AUTH_URL, env.DASHBOARD_URL];

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
    // reply.hijack() hands the socket to Better Auth and skips the rest of
    // Fastify's lifecycle — including @fastify/cors's onSend hook, which is
    // what normally attaches these headers. The OPTIONS preflight still gets
    // them (it never reaches this handler), so the failure looks bizarre from
    // the server side: the browser's preflight passes, the real request is
    // processed and returns 200, and then the browser discards the response
    // as cross-origin because it arrived bare. Setting them on reply.raw is
    // the only place that survives the hijack — reply.header() would be
    // buffered for a send() that never happens.
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      reply.raw.setHeader('access-control-allow-origin', origin);
      reply.raw.setHeader('access-control-allow-credentials', 'true');
      reply.raw.setHeader('vary', 'Origin');
    }

    reply.hijack();
    await toNodeHandler(auth)(req.raw, reply.raw);
  });
}
