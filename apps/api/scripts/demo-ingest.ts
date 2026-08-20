/**
 * End-to-end ingestion demo against the real Gemini API.
 *
 * Uploads a synthetic 24-page handbook, waits for the worker, and prints the
 * resulting chunks with their page spans and token counts, then verifies the
 * stored vectors' dimensions and norms directly in Postgres. Cleans up after
 * itself. Run with: npm run demo:ingest -w @groundwork/api
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { organization } from '../src/db/schema/index.ts';
import { workerPool } from '../src/modules/ingestion/queue.ts';
import { makePdf } from '../tests/helpers/make-pdf.ts';

const ORIGIN = 'http://localhost:3000';
const email = `live-${randomUUID()}@example.com`;
const slug = `live-${randomUUID()}`;

// Real embedder — no override.
const { app, worker } = await buildApp({ logger: false });
await app.ready();

const signup = await app.inject({
  method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: ORIGIN },
  payload: { email, password: 'supersecret123', name: 'Live' },
});
const cookie = signup.headers['set-cookie']!.toString().split(';')[0]!;
const h = { cookie, origin: ORIGIN };

const org = await app.inject({
  method: 'POST', url: '/api/auth/organization/create', headers: h,
  payload: { name: 'Live Co', slug },
});
await app.inject({
  method: 'POST', url: '/api/auth/organization/set-active', headers: h,
  payload: { organizationId: org.json().id },
});

const SECTIONS = [
  ['Warranty Coverage', 'All Acme robots carry a 24-month limited warranty covering parts and labour from the date of delivery. The warranty covers manufacturing defects, motor failure, and battery degradation below seventy percent of rated capacity. It does not cover water damage, unauthorised modification, or wear on consumable components such as brushes and filters. Warranty claims require the original order number.'],
  ['Returns and Refunds', 'Returns are accepted within 30 days of delivery provided the original packaging is intact and all accessories are included. Refunds are issued to the original payment method within 14 business days of the returned unit arriving at our depot. Units returned after 30 days may be eligible for store credit at the discretion of support staff.'],
  ['Shipping', 'Shipping is free on orders over fifty dollars within the continental United States. Orders below that threshold incur a flat nine dollar charge. Expedited two-day shipping is available for an additional nineteen dollars. We do not currently ship to PO boxes or to addresses outside North America.'],
  ['Account and Billing', 'Subscriptions are billed monthly on the date you first subscribed. Changing plans mid-cycle results in a prorated charge or credit applied to the following invoice. Cancelling stops future billing immediately but does not refund the current period. Invoices are available in the billing section of your account.'],
  ['Troubleshooting', 'If a robot fails to power on, hold the reset button for ten seconds while connected to mains power. Persistent charging faults usually indicate a failed dock contact plate, which is covered under warranty. Firmware updates install automatically overnight when the unit is docked and connected to wifi.'],
  ['Data and Privacy', 'Mapping data collected by the robot is stored locally on the device and synced to your account only when cloud backup is enabled. You can delete stored maps at any time from the app. We never sell customer mapping data to third parties.'],
];

// Repeat the section set so the handbook is large enough to exercise
// multi-chunk splitting, page spans, and batched embedding calls.
const PAGES = Array.from({ length: 4 }, (_, pass) =>
  SECTIONS.map(([h, body]) => `${h}${pass ? ` (part ${pass + 1})` : ''}. ${body}`),
).flat();
const pdf = makePdf(PAGES);

const boundary = '----live';
const body = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="acme-handbook.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
  Buffer.from(pdf),
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);

console.log('uploading acme-handbook.pdf ...');
const started = Date.now();
const up = await app.inject({
  method: 'POST', url: '/v1/documents',
  headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: body,
});
const docId = up.json().id;
console.log(`  accepted as ${docId} (HTTP ${up.statusCode})`);

await worker.drained();
const elapsed = Date.now() - started;

const status = await app.inject({ method: 'GET', url: `/v1/documents/${docId}/status`, headers: h });
console.log('  status:', JSON.stringify(status.json()));

const chunks = await app.inject({ method: 'GET', url: `/v1/documents/${docId}/chunks`, headers: h });
console.log(`\nchunks (${chunks.json().length}) in ${elapsed}ms:`);
for (const c of chunks.json()) {
  console.log(`  [${c.chunkIndex}] p.${c.pageFrom}-${c.pageTo} ~${c.tokenCount}tok :: ${c.content.slice(0, 68).replace(/\n/g, ' ')}...`);
}

// Verify the stored vectors directly in Postgres. This must run inside the
// tenant scope: an unscoped query is blocked by RLS and silently returns zero
// rows, which looks exactly like "nothing was stored".
const check = await withTenant(org.json().id, (tx) => tx.execute(`
  SELECT count(*)::int AS n,
         min(vector_dims(embedding))::int AS dims,
         round(min(sqrt(inner_product(embedding, embedding)))::numeric, 6) AS min_norm,
         round(max(sqrt(inner_product(embedding, embedding)))::numeric, 6) AS max_norm
  FROM document_chunks WHERE document_id = '${docId}'`));
console.log('\nstored vectors:', JSON.stringify((check.rows ?? check)[0]));

await db.delete(organization).where(eq(organization.id, org.json().id));
await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
await app.close();
await pool.end();
await workerPool.end();
console.log('\ncleaned up.');
