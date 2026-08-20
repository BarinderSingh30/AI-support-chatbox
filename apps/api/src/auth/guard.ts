import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from './auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    orgId?: string;
    userId?: string;
  }
}

/**
 * Resolves the caller's session and active organization, and rejects anything
 * without both. Downstream handlers can treat req.orgId as trustworthy — it is
 * the value every withTenant call is keyed on.
 */
export async function requireOrg(req: FastifyRequest, reply: FastifyReply) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return reply.code(401).send({ error: 'authentication required' });

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    return reply.code(400).send({
      error: 'no active organization',
      hint: 'call POST /api/auth/organization/set-active first',
    });
  }
  req.orgId = orgId;
  req.userId = session.user.id;
}
