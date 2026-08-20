/**
 * End-to-end RAG demo against the real Gemini API.
 *
 * Ingests a small handbook, then asks three questions chosen to exercise the
 * three behaviours that matter: a semantic match, an exact-token match that pure
 * vector search would blur, and an out-of-scope question that must be refused
 * without the model ever being called.
 *
 * Run with: npm run demo:chat -w @groundwork/api
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { organization, orgSettings, usageEvents } from '../src/db/schema/index.ts';
import { workerPool } from '../src/modules/ingestion/queue.ts';

const ORIGIN = 'http://localhost:3000';
const email = `demo-${randomUUID()}@example.com`;
const ORG_NAME = 'Acme Robotics (demo)';

const { app, worker } = await buildApp({ logger: false });
await app.ready();

const signup = await app.inject({
  method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: ORIGIN },
  payload: { email, password: 'supersecret123', name: 'Demo' },
});
const cookie = signup.headers['set-cookie']!.toString().split(';')[0]!;
const h = { cookie, origin: ORIGIN };

const org = await app.inject({
  method: 'POST', url: '/api/auth/organization/create', headers: h,
  payload: { name: ORG_NAME, slug: `demo-${randomUUID()}` },
});
const orgId = org.json().id;
await app.inject({
  method: 'POST', url: '/api/auth/organization/set-active', headers: h,
  payload: { organizationId: orgId },
});

await withTenant(orgId, (tx) => tx.insert(orgSettings).values({
  orgId,
  noAnswerMessage: "I couldn't find that in Acme's documentation. Please email support@acme.test.",
}));

const HANDBOOK = `# Warranty Coverage

All Acme robots carry a 24-month limited warranty covering parts and labour from the date of delivery. The warranty covers manufacturing defects, motor failure, and battery degradation below seventy percent of rated capacity. It does not cover water damage or unauthorised modification.

# Returns and Refunds

Returns are accepted within 30 days of delivery provided the original packaging is intact. Refunds are issued to the original payment method within 14 business days of the returned unit arriving at our depot.

# Replacement Parts

Replacement part SKU-4471 is the dock contact plate for the model R2 chassis. Part SKU-8802 is the primary brush assembly and is treated as a consumable.

# Shipping

Shipping is free on orders over fifty dollars within the continental United States. Expedited two-day shipping costs an additional nineteen dollars.`;

console.log('ingesting handbook ...');
const doc = await app.inject({
  method: 'POST', url: '/v1/documents/text', headers: h,
  payload: { title: 'Acme Support Handbook', text: HANDBOOK },
});
await worker.drained();
const status = await app.inject({
  method: 'GET', url: `/v1/documents/${doc.json().id}/status`, headers: h,
});
console.log(`  ${status.json().chunkCount} chunks indexed\n`);

const QUESTIONS = [
  ['semantic match      ', 'How long am I covered if my robot stops working?'],
  ['exact token match   ', 'What is SKU-4471?'],
  ['out of scope (gate) ', 'What is the capital of France?'],
];

for (const [label, question] of QUESTIONS) {
  const res = await app.inject({
    method: 'POST', url: '/v1/chat', headers: h, payload: { question },
  });
  const events = res.body.split('\n\n').filter(Boolean).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1] ?? '',
    data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? '{}'),
  }));
  const text = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  const cites = events.find((e) => e.event === 'citations')?.data.citations ?? [];
  const done = events.find((e) => e.event === 'done')!.data;

  console.log(`── ${label} ────────────────────────────────`);
  console.log(`Q: ${question}`);
  console.log(`A: ${text.trim()}`);
  console.log(
    `   answered=${done.answered} topScore=${done.topScore.toFixed(3)} ` +
    `latency=${done.latencyMs}ms cost=$${done.costUsd.toFixed(6)}`,
  );
  for (const c of cites) {
    console.log(`   [${c.n}] ${c.documentTitle} > ${c.headingPath} (sim ${c.similarity.toFixed(3)})`);
  }
  console.log();
}

const spend = await withTenant(orgId, (tx) => tx.select().from(usageEvents));
const total = spend.reduce((s, u) => s + Number(u.costUsd), 0);
console.log(`total spend for this run: $${total.toFixed(6)} across ${spend.length} API calls`);

await db.delete(organization).where(eq(organization.id, orgId));
await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
await app.close();
await pool.end();
await workerPool.end();
