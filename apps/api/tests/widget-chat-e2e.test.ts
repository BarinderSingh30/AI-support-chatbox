import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db/client.ts';
import { organization } from '../src/db/schema/index.ts';
import { workerPool } from '../src/modules/ingestion/queue.ts';
import { publicPool } from '../src/modules/widget-keys/service.ts';
import { l2Normalize } from '../src/modules/ingestion/vectors.ts';
import type { Embedder } from '../src/modules/ingestion/embedder.ts';
import type { ChatProvider, ChatUsage } from '../src/llm/provider.ts';
import type { Worker } from '../src/modules/ingestion/worker.ts';

const APP_ORIGIN = 'http://localhost:3000';
const CLIENT_SITE = 'https://client-site.test';
const email = `widget-${randomUUID()}@example.com`;
const ORG_NAME = 'Widget E2E Co';

let app: FastifyInstance;
let worker: Worker;
let adminCookie = '';
let publicKey = '';

const flat = l2Normalize(Array.from({ length: 768 }, (_, i) => Math.sin(i)));
const embedder: Embedder = {
  embedDocuments: async (t) => t.map(() => flat),
  embedQuery: async () => flat,
};
const chat: ChatProvider = {
  async *stream(): AsyncGenerator<string, ChatUsage, undefined> {
    for (const part of ['Refunds ', 'take ', '14 days ', '[1].']) yield part;
    return { inputTokens: 900, outputTokens: 40 };
  },
};

const asAdmin = () => ({ cookie: adminCookie, origin: APP_ORIGIN });
const asWidget = (origin: string) => ({ origin, 'x-widget-origin': origin, 'x-widget-key': publicKey });

function parseSse(body: string) {
  return body.split('\n\n').filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1] ?? '',
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}'),
  }));
}

beforeAll(async () => {
  ({ app, worker } = await buildApp({ embedder, chat, logger: false }));
  await app.ready();

  const signup = await app.inject({
    method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: APP_ORIGIN },
    payload: { email, password: 'supersecret123', name: 'Widget' },
  });
  adminCookie = signup.headers['set-cookie']!.toString().split(';')[0]!;

  const org = await app.inject({
    method: 'POST', url: '/api/auth/organization/create',
    headers: asAdmin(), payload: { name: ORG_NAME, slug: `widget-${randomUUID()}` },
  });
  await app.inject({
    method: 'POST', url: '/api/auth/organization/set-active',
    headers: asAdmin(), payload: { organizationId: org.json().id },
  });

  await app.inject({
    method: 'POST', url: '/v1/documents/text', headers: asAdmin(),
    payload: { title: 'Policy', text: '# Refunds\n\nRefunds take 14 days to process.' },
  });
  await worker.drained();

  const key = await app.inject({
    method: 'POST', url: '/v1/widget-keys', headers: asAdmin(),
    payload: { name: 'Client site', allowedOrigins: [CLIENT_SITE], rateLimitRpm: 3 },
  });
  publicKey = key.json().publicKey;
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.name, ORG_NAME));
  await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
  await app.close();
  await pool.end();
  await workerPool.end();
  await publicPool.end();
});

describe('widget chat over public key auth', () => {
  it(
    'carries the CORS header on the actual streamed response, not just the preflight',
    async () => {
      // streamAnswer writes response headers directly via reply.raw.writeHead(),
      // which bypasses (and previously discarded) anything Fastify's own
      // reply.header() had already queued from the onRequest hook. A preflight
      // OPTIONS request going through Fastify's normal pipeline would still
      // pass even with this bug, which is exactly why it wasn't caught until a
      // real browser tried to read the actual POST response and rejected the
      // fetch outright. See docs/phases/phase-3-widget.md.
      const res = await app.inject({
        method: 'POST', url: '/v1/widget/chat',
        headers: asWidget(CLIENT_SITE),
        payload: { question: 'How long do refunds take?' },
      });
      expect(res.headers['access-control-allow-origin']).toBe(CLIENT_SITE);
    },
  );

  it('answers a visitor from an allowed origin with no session at all', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: asWidget(CLIENT_SITE),
      payload: { question: 'How long do refunds take?' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const text = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    expect(text).toContain('14 days');
    expect(events.find((e) => e.event === 'done')!.data.answered).toBe(true);
  });

  it(
    'checks the allowlist against x-widget-origin, not the raw browser Origin header',
    async () => {
      // The chat iframe is hosted at ITS OWN origin, so the browser's automatic
      // Origin header on its fetch NEVER matches a client site's allowlisted
      // domain — that is structurally guaranteed, not a bug in one deployment.
      // The loader captures the real embedding page's origin and forwards it
      // as x-widget-origin instead; that is what must drive the decision.
      const res = await app.inject({
        method: 'POST', url: '/v1/widget/chat',
        headers: {
          origin: 'https://widget-hosting-domain.example', // the iframe's own, structurally irrelevant, origin
          'x-widget-origin': CLIENT_SITE, // what the loader actually captured
          'x-widget-key': publicKey,
        },
        payload: { question: 'How long do refunds take?' },
      });
      expect(res.statusCode).toBe(200);
    },
  );

  it('rejects a request from an origin not on the allowlist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: asWidget('https://evil.test'),
      payload: { question: 'How long do refunds take?' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/origin/i);
  });

  it('rejects an unknown widget key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: { origin: CLIENT_SITE, 'x-widget-key': 'pk_live_bogus' },
      payload: { question: 'hi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers a CORS preflight for the client site without needing the key', async () => {
    const res = await app.inject({
      method: 'OPTIONS', url: '/v1/widget/chat', headers: { origin: CLIENT_SITE },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CLIENT_SITE);
    expect(res.headers['access-control-allow-headers']).toContain('x-widget-key');
  });

  it('reflects the requesting origin so a browser can read even a rejected response', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: asWidget('https://evil.test'),
      payload: { question: 'hi' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://evil.test');
  });

  it('rate-limits a widget key after its configured requests-per-minute', async () => {
    // A fresh key, so no earlier test's usage counts against this budget.
    const key = await app.inject({
      method: 'POST', url: '/v1/widget-keys', headers: asAdmin(),
      payload: { name: 'rate-limit-test', allowedOrigins: [CLIENT_SITE], rateLimitRpm: 3 },
    });
    const scopedHeaders = { origin: CLIENT_SITE, 'x-widget-origin': CLIENT_SITE, 'x-widget-key': key.json().publicKey };

    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({
        method: 'POST', url: '/v1/widget/chat', headers: scopedHeaders, payload: { question: `q${i}` },
      });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'POST', url: '/v1/widget/chat', headers: scopedHeaders, payload: { question: 'one too many' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('creates an anonymous session that a follow-up question can continue', async () => {
    const key = await app.inject({
      method: 'POST', url: '/v1/widget-keys', headers: asAdmin(),
      payload: { name: 'session-test', allowedOrigins: [CLIENT_SITE] },
    });
    const scopedHeaders = { origin: CLIENT_SITE, 'x-widget-origin': CLIENT_SITE, 'x-widget-key': key.json().publicKey };

    const first = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: scopedHeaders, payload: { question: 'How long do refunds take?', visitorId: 'v-1' },
    });
    const sessionId = parseSse(first.body).find((e) => e.event === 'done')!.data.sessionId;

    const second = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: scopedHeaders,
      payload: { question: 'And again?', sessionId, visitorId: 'v-1' },
    });
    expect(parseSse(second.body).find((e) => e.event === 'done')!.data.sessionId).toBe(sessionId);
  });
});

describe('widget config', () => {
  it('returns the greeting and suggested questions for an allowed origin', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/widget/config', headers: asWidget(CLIENT_SITE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      welcomeMessage: expect.any(String),
      suggestedQuestions: expect.any(Array),
    });
  });

  it('rejects a config request from an origin not on the allowlist', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/widget/config', headers: asWidget('https://evil.test'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not count against the widget key rate limit', async () => {
    // Reading config on mount must not compete with the message budget a
    // visitor uses to actually talk to the bot.
    const key = await app.inject({
      method: 'POST', url: '/v1/widget-keys', headers: asAdmin(),
      payload: { name: 'config-rate-test', allowedOrigins: [CLIENT_SITE], rateLimitRpm: 1 },
    });
    const scopedHeaders = { origin: CLIENT_SITE, 'x-widget-origin': CLIENT_SITE, 'x-widget-key': key.json().publicKey };
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/widget/config', headers: scopedHeaders });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('widget key management', () => {
  it('requires an admin session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/widget-keys' });
    expect(res.statusCode).toBe(401);
  });

  it('lists keys for the caller org only', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/widget-keys', headers: asAdmin() });
    expect(res.json().some((k: { publicKey: string }) => k.publicKey === publicKey)).toBe(true);
  });

  it('revokes a key so it stops authenticating', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/widget-keys', headers: asAdmin(),
      payload: { name: 'temp', allowedOrigins: [CLIENT_SITE] },
    });
    const del = await app.inject({
      method: 'DELETE', url: `/v1/widget-keys/${created.json().id}`, headers: asAdmin(),
    });
    expect(del.statusCode).toBe(204);

    const chatRes = await app.inject({
      method: 'POST', url: '/v1/widget/chat',
      headers: { origin: CLIENT_SITE, 'x-widget-key': created.json().publicKey },
      payload: { question: 'hi' },
    });
    expect(chatRes.statusCode).toBe(401);
  });
});
