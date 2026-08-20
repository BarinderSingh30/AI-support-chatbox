import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { organization, orgSettings } from '../src/db/schema/index.ts';
import { getWidgetConfig } from '../src/modules/widget-keys/config.ts';

const org = `wc-${randomUUID()}`;

beforeAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
});

describe('getWidgetConfig', () => {
  it('returns the configured welcome message and suggested questions', async () => {
    await withTenant(org, (tx) =>
      tx.insert(orgSettings).values({
        orgId: org,
        welcomeMessage: 'Hi! How can I help?',
        suggestedQuestions: ['What is your return policy?', 'How long is the warranty?'],
      }),
    );
    const config = await getWidgetConfig(org);
    expect(config.welcomeMessage).toBe('Hi! How can I help?');
    expect(config.suggestedQuestions).toEqual([
      'What is your return policy?', 'How long is the warranty?',
    ]);
  });

  it('falls back to a generic greeting and no suggestions when unconfigured', async () => {
    const bare = `wc-bare-${randomUUID()}`;
    await db.insert(organization).values({ id: bare, name: bare, slug: bare, createdAt: new Date() });
    // No org_settings row at all — the common case for a brand-new org.
    const config = await getWidgetConfig(bare);
    expect(config.welcomeMessage).toBe('Hi! Ask me anything.');
    expect(config.suggestedQuestions).toEqual([]);
    await db.delete(organization).where(eq(organization.id, bare));
  });
});
