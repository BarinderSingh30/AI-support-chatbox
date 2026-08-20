import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { organization } from '../src/db/schema/index.ts';
import { getOrgSettings, upsertOrgSettings } from '../src/modules/org-settings/service.ts';

const org = `os-${randomUUID()}`;

beforeAll(async () => {
  await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
});

describe('getOrgSettings', () => {
  it('returns sensible defaults for a brand-new org with no row yet', async () => {
    const settings = await getOrgSettings(org);
    expect(settings.welcomeMessage).toBe('Hi! Ask me anything.');
    expect(settings.suggestedQuestions).toEqual([]);
    expect(settings.minScore).toBe(0.65);
    expect(settings.topK).toBe(6);
  });
});

describe('upsertOrgSettings', () => {
  it('creates a row on first write and returns the merged view', async () => {
    const updated = await upsertOrgSettings(org, {
      welcomeMessage: 'Welcome to Acme support!',
      suggestedQuestions: ['What are your hours?'],
    });
    expect(updated.welcomeMessage).toBe('Welcome to Acme support!');
    expect(updated.suggestedQuestions).toEqual(['What are your hours?']);
    // Untouched fields keep their defaults.
    expect(updated.minScore).toBe(0.65);
  });

  it('updates only the given fields on a second write, keeping the rest', async () => {
    await upsertOrgSettings(org, { welcomeMessage: 'First' });
    const updated = await upsertOrgSettings(org, { minScore: 0.7 });
    expect(updated.welcomeMessage).toBe('First');
    expect(updated.minScore).toBe(0.7);
  });

  it('persists across reads', async () => {
    await upsertOrgSettings(org, { topK: 8 });
    const settings = await getOrgSettings(org);
    expect(settings.topK).toBe(8);
  });

  it('accepts an explicit null to clear systemPrompt', async () => {
    // The dashboard's widget configurator (Task 12) round-trips the whole
    // settings object on every save, including an unset systemPrompt as
    // `null` — not omitted — so the update path must accept null, not just
    // `string | undefined`.
    await upsertOrgSettings(org, { systemPrompt: 'Be extra polite.' });
    const cleared = await upsertOrgSettings(org, { systemPrompt: null });
    expect(cleared.systemPrompt).toBeNull();
  });
});
