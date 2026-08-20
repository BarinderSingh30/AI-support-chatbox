import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db/client.ts';
import { organization } from '../src/db/schema/index.ts';
import { workerPool } from '../src/modules/ingestion/queue.ts';
import { l2Normalize } from '../src/modules/ingestion/vectors.ts';
import type { Embedder } from '../src/modules/ingestion/embedder.ts';
import type { ChatProvider, ChatUsage } from '../src/llm/provider.ts';
import type { Worker } from '../src/modules/ingestion/worker.ts';

const ORIGIN = 'http://localhost:3000';
const email = `chat-${randomUUID()}@example.com`;
const ORG_NAME = 'Chat E2E Co';

let app: FastifyInstance;
let worker: Worker;
let cookie = '';

/**
 * Same vector for everything, so retrieval always clears the relevance gate and
 * the test exercises the streaming path rather than the gate.
 */
const flat = l2Normalize(Array.from({ length: 768 }, (_, i) => Math.sin(i)));
const embedder: Embedder = {
  embedDocuments: async (t) => t.map(() => flat),
  embedQuery: async () => flat,
};

const chat: ChatProvider = {
  async *stream(): AsyncGenerator<string, ChatUsage, undefined> {
    for (const part of ['Refunds ', 'are issued ', 'within 14 days ', '[1].']) yield part;
    return { inputTokens: 900, outputTokens: 40 };
  },
};

const authed = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, ...extra });

/** Parses an SSE body into typed events. */
function parseSse(body: string) {
  return body.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
    const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
    return { event, data: JSON.parse(data) };
  });
}

beforeAll(async () => {
  ({ app, worker } = await buildApp({ embedder, chat, logger: false }));
  await app.ready();

  const signup = await app.inject({
    method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: ORIGIN },
    payload: { email, password: 'supersecret123', name: 'Chat' },
  });
  cookie = signup.headers['set-cookie']!.toString().split(';')[0]!;

  const org = await app.inject({
    method: 'POST', url: '/api/auth/organization/create',
    headers: authed(), payload: { name: ORG_NAME, slug: `chat-${randomUUID()}` },
  });
  await app.inject({
    method: 'POST', url: '/api/auth/organization/set-active',
    headers: authed(), payload: { organizationId: org.json().id },
  });

  await app.inject({
    method: 'POST', url: '/v1/documents/text', headers: authed(),
    payload: {
      title: 'Policy',
      text: '# Refunds\n\nRefunds are issued within 14 days of the returned unit arriving at our depot.',
    },
  });
  await worker.drained();
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.name, ORG_NAME));
  await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
  await app.close();
  await pool.end();
  await workerPool.end();
});

describe('chat over SSE', () => {
  it('streams an answer with citations and a done event', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat', headers: authed(),
      payload: { question: 'How long do refunds take?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.body);
    const text = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    expect(text).toContain('14 days');

    const citations = events.find((e) => e.event === 'citations')!.data.citations;
    expect(citations).toHaveLength(1);
    expect(citations[0].headingPath).toBe('Refunds');
    expect(citations[0].documentTitle).toBe('Policy');

    const done = events.find((e) => e.event === 'done')!.data;
    expect(done.answered).toBe(true);
    expect(done.sessionId).toBeTruthy();
    expect(done.costUsd).toBeGreaterThan(0);
  });

  it('returns the transcript with the passages the answer used', async () => {
    const ask = await app.inject({
      method: 'POST', url: '/v1/chat', headers: authed(),
      payload: { question: 'How long do refunds take?' },
    });
    const { sessionId } = parseSse(ask.body).find((e) => e.event === 'done')!.data;

    const res = await app.inject({
      method: 'GET', url: `/v1/chat/sessions/${sessionId}`, headers: authed(),
    });
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].citations[0].content).toContain('14 days');
  });

  it('rejects an empty question', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat', headers: authed(), payload: { question: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat', payload: { question: 'hello' },
    });
    expect(res.statusCode).toBe(401);
  });
});
