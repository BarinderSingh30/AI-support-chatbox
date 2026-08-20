import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { chatMessages, chatSessions, organization } from '../src/db/schema/index.ts';
import { checkMonthlyCap } from '../src/modules/widget-keys/monthly-cap.ts';
import { createWidgetKey } from '../src/modules/widget-keys/service.ts';

const org = `mc-${randomUUID()}`;
let widgetKeyId: string;

async function recordMessages(count: number) {
  await withTenant(org, async (tx) => {
    const [session] = await tx.insert(chatSessions).values({
      orgId: org, widgetKeyId,
    }).returning({ id: chatSessions.id });
    for (let i = 0; i < count; i++) {
      await tx.insert(chatMessages).values({
        orgId: org, sessionId: session!.id, role: 'user', content: `q${i}`,
      });
    }
  });
}

beforeAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
  const key = await createWidgetKey(org, { name: 'cap-test', allowedOrigins: ['https://acme.test'] });
  widgetKeyId = key.id;
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
});

describe('checkMonthlyCap', () => {
  it('allows usage under the cap', async () => {
    await recordMessages(3);
    expect(await checkMonthlyCap(org, widgetKeyId, 1000)).toBe(true);
  });

  it('blocks usage once the cap is reached', async () => {
    await recordMessages(1000); // 1003 total now, well past a cap of 5
    expect(await checkMonthlyCap(org, widgetKeyId, 5)).toBe(false);
  });

  it('does not count messages from a different widget key', async () => {
    const other = `mc-other-${randomUUID()}`;
    await db.insert(organization).values({ id: other, name: other, slug: other, createdAt: new Date() });
    const freshKey = await createWidgetKey(other, { name: 'fresh', allowedOrigins: ['https://x.test'] });
    expect(await checkMonthlyCap(other, freshKey.id, 5)).toBe(true);
    await db.delete(organization).where(eq(organization.id, other));
  });
});
