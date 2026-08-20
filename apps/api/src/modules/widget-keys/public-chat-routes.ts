import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveWidgetContext } from '../../auth/public-guard.ts';
import { streamAnswer } from '../chat/stream.ts';
import { checkMonthlyCap } from './monthly-cap.ts';
import { createRateLimiter } from './rate-limiter.ts';
import type { AnswerDeps } from '../chat/answer.ts';

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  sessionId: z.string().optional(),
  visitorId: z.string().optional(),
});

/**
 * The endpoint the embedded widget actually calls: no session, authenticated
 * by public key + origin instead.
 *
 * CORS here is deliberately permissive at the transport level (any Origin can
 * complete the handshake) because the real authorization boundary is the
 * application-level origin-allowlist check in resolveWidgetContext, which
 * returns a readable 403 with a reason. CORS was never a security boundary
 * against a direct server-to-server call anyway — anyone can curl this
 * endpoint regardless of what CORS headers say. Reflecting the Origin just
 * means a *browser* client gets to read that 403 body instead of an opaque
 * network error, which matters when a developer is debugging their embed.
 */
export function publicChatRoutes(deps: AnswerDeps) {
  const rateLimiter = createRateLimiter();

  return async function routes(app: FastifyInstance) {
    // CORS on this route needs its own onRequest hook, not the fastify/cors
    // plugin: that plugin is configured for the app's own origin and this
    // route deliberately accepts any origin at the transport level (see the
    // module docstring for why that's safe).
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin) {
        reply.header('access-control-allow-origin', origin);
        reply.header('vary', 'Origin');
      }
    });

    // A dedicated route rather than branching on method inside a hook: Fastify
    // only runs a plugin's hooks for requests that match a route registered in
    // that plugin, so OPTIONS needs its own registration to be reachable at all.
    app.options('/v1/widget/chat', async (_req, reply) => {
      reply.header('access-control-allow-methods', 'POST, OPTIONS');
      reply.header('access-control-allow-headers', 'content-type, x-widget-key, x-widget-origin');
      return reply.code(204).send();
    });

    app.post('/v1/widget/chat', async (req, reply) => {
      const publicKey = req.headers['x-widget-key'] as string | undefined;
      // NOT req.headers.origin: the chat iframe is hosted at its own origin,
      // so the browser's automatic Origin header on its own fetch always
      // reports THAT origin — never the embedding page's. x-widget-origin is
      // captured by the loader script, which runs directly in the real
      // parent page and genuinely has access to its origin. See
      // docs/phases/phase-3-widget.md for how this was found.
      const parentOrigin = req.headers['x-widget-origin'] as string | undefined;

      const ctx = await resolveWidgetContext(publicKey, parentOrigin);
      if (!ctx.ok) return reply.code(ctx.status).send({ error: ctx.error });

      if (!rateLimiter.tryConsume(ctx.widgetKeyId, ctx.rateLimitRpm)) {
        return reply.code(429).send({ error: 'rate limit exceeded, try again shortly' });
      }
      if (!(await checkMonthlyCap(ctx.orgId, ctx.widgetKeyId, ctx.monthlyMsgCap))) {
        return reply.code(429).send({ error: 'monthly message limit reached for this widget' });
      }

      const body = askSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });

      await streamAnswer(reply, {
        orgId: ctx.orgId,
        question: body.data.question,
        sessionId: body.data.sessionId,
        widgetKeyId: ctx.widgetKeyId,
        // A visitor with no prior session gets one generated client-side by the
        // widget and persisted in localStorage; this is a fallback only.
        visitorId: body.data.visitorId ?? randomUUID(),
        origin: parentOrigin,
        userAgent: req.headers['user-agent'],
        deps,
      });
    });
  };
}
