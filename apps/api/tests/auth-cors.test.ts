import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { pool } from '../src/db/client.ts';
import { workerPool } from '../src/modules/ingestion/queue.ts';
import { publicPool } from '../src/modules/widget-keys/service.ts';
import { env } from '../src/env.ts';

/**
 * Regression cover for a bug found only by clicking through a real browser:
 * the /api/auth/* handler calls reply.hijack(), which skips the rest of
 * Fastify's lifecycle — including @fastify/cors's onSend hook. The OPTIONS
 * preflight kept working (it never reaches that handler), so the server logged
 * a clean 200 for every sign-in while the browser threw "Failed to fetch" and
 * discarded the response as cross-origin. curl never noticed either, because
 * curl doesn't enforce CORS. Only the actual POST response is load-bearing here.
 */
let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await buildApp({ logger: false }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Promise.all([pool.end(), workerPool.end(), publicPool.end()]);
});

describe('CORS on the hijacked /api/auth/* routes', () => {
  it('attaches CORS headers to the actual POST response, not just the preflight', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: env.DASHBOARD_URL, 'content-type': 'application/json' },
      payload: { email: 'nobody@example.test', password: 'wrong-password-on-purpose' },
    });

    // The credentials are deliberately bad: what's under test is that the
    // response carries the headers at all, not whether sign-in succeeded.
    expect(res.headers['access-control-allow-origin']).toBe(env.DASHBOARD_URL);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an origin outside the allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      payload: { email: 'nobody@example.test', password: 'wrong-password-on-purpose' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still answers the preflight for the dashboard origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/sign-in/email',
      headers: {
        origin: env.DASHBOARD_URL,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(env.DASHBOARD_URL);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
