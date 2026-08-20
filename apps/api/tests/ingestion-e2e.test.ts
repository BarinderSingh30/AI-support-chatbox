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
import type { Worker } from '../src/modules/ingestion/worker.ts';
import { makePdf } from './helpers/make-pdf.ts';

const ORIGIN = 'http://localhost:3000';
const email = `e2e-${randomUUID()}@example.com`;

let app: FastifyInstance;
let worker: Worker;
let cookie = '';

const fakeEmbedder: Embedder = {
  embedDocuments: async (texts) =>
    texts.map((t) => l2Normalize(Array.from({ length: 768 }, (_, i) => Math.sin(i + t.length)))),
  embedQuery: async () => l2Normalize(Array.from({ length: 768 }, (_, i) => Math.cos(i))),
};

/** Auth endpoints reject state-changing requests without an Origin header. */
const authed = (extra: Record<string, string> = {}) => ({
  cookie, origin: ORIGIN, ...extra,
});

beforeAll(async () => {
  ({ app, worker } = await buildApp({ embedder: fakeEmbedder, logger: false }));
  await app.ready();

  const signup = await app.inject({
    method: 'POST', url: '/api/auth/sign-up/email',
    headers: { origin: ORIGIN },
    payload: { email, password: 'supersecret123', name: 'E2E' },
  });
  cookie = signup.headers['set-cookie']!.toString().split(';')[0]!;

  const org = await app.inject({
    method: 'POST', url: '/api/auth/organization/create',
    headers: authed(), payload: { name: 'E2E Co', slug: `e2e-${randomUUID()}` },
  });
  const orgId = org.json().id;

  await app.inject({
    method: 'POST', url: '/api/auth/organization/set-active',
    headers: authed(), payload: { organizationId: orgId },
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.name, 'E2E Co'));
  await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
  await app.close();
  await pool.end();
  await workerPool.end();
});

describe('ingestion over HTTP', () => {
  it('rejects an unauthenticated upload', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/documents' });
    expect(res.statusCode).toBe(401);
  });

  it('ingests pasted text and produces chunks', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/documents/text', headers: authed(),
      payload: {
        title: 'Refund Policy',
        text: '# Refunds\n\nRefunds are issued within 14 days of the request.',
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();

    await worker.drained();

    const status = await app.inject({
      method: 'GET', url: `/v1/documents/${id}/status`, headers: authed(),
    });
    expect(status.json().status).toBe('ready');
    expect(status.json().chunkCount).toBeGreaterThan(0);

    const chunks = await app.inject({
      method: 'GET', url: `/v1/documents/${id}/chunks`, headers: authed(),
    });
    expect(chunks.json()[0].headingPath).toBe('Refunds');
  });

  it('ingests an uploaded PDF and records page numbers', async () => {
    const pdf = makePdf(['Warranty covers parts for twenty four months.', 'Shipping is free over fifty dollars.']);
    const boundary = '----groundworktest';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="handbook.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(pdf),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST', url: '/v1/documents',
      headers: authed({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
      payload: body,
    });
    expect(res.statusCode).toBe(201);

    await worker.drained();

    const chunks = await app.inject({
      method: 'GET', url: `/v1/documents/${res.json().id}/chunks`, headers: authed(),
    });
    const rows = chunks.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c: { pageFrom: number }) => c.pageFrom >= 1)).toBe(true);
  });

  it('does not re-embed identical content', async () => {
    const payload = { title: 'Dupe', text: 'This exact content is uploaded twice over.' };
    const first = await app.inject({ method: 'POST', url: '/v1/documents/text', headers: authed(), payload });
    const second = await app.inject({ method: 'POST', url: '/v1/documents/text', headers: authed(), payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().id).toBe(first.json().id);
  });

  it('rejects an unsupported file type', async () => {
    const boundary = '----groundworktest2';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="virus.exe"\r\nContent-Type: application/octet-stream\r\n\r\nMZ`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST', url: '/v1/documents',
      headers: authed({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
      payload: body,
    });
    expect(res.statusCode).toBe(415);
  });

  it('deletes a document and its chunks together', async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/documents/text', headers: authed(),
      payload: { title: 'Temp', text: 'Content that will shortly be deleted again.' },
    });
    await worker.drained();
    const id = created.json().id;

    const del = await app.inject({ method: 'DELETE', url: `/v1/documents/${id}`, headers: authed() });
    expect(del.statusCode).toBe(204);

    const chunks = await app.inject({ method: 'GET', url: `/v1/documents/${id}/chunks`, headers: authed() });
    expect(chunks.json()).toEqual([]);
  });
});
