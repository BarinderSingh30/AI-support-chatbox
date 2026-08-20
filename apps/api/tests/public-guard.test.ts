import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { organization } from '../src/db/schema/index.ts';
import { createWidgetKey, revokeWidgetKey, publicPool } from '../src/modules/widget-keys/service.ts';
import { resolveWidgetContext } from '../src/auth/public-guard.ts';

const org = `pg-${randomUUID()}`;

beforeAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
  await publicPool.end();
});

describe('resolveWidgetContext', () => {
  it('accepts a key and an origin on its allowlist', async () => {
    const key = await createWidgetKey(org, { name: 'k', allowedOrigins: ['https://acme.test'] });
    const result = await resolveWidgetContext(key.publicKey, 'https://acme.test');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.orgId).toBe(org);
  });

  it('rejects a missing key', async () => {
    const result = await resolveWidgetContext(undefined, 'https://acme.test');
    expect(result).toEqual({ ok: false, status: 401, error: 'missing widget key' });
  });

  it('rejects an unknown key', async () => {
    const result = await resolveWidgetContext('pk_live_bogus', 'https://acme.test');
    expect(result).toEqual({ ok: false, status: 401, error: 'invalid widget key' });
  });

  it('rejects a revoked key', async () => {
    const key = await createWidgetKey(org, { name: 'r', allowedOrigins: ['https://acme.test'] });
    await revokeWidgetKey(org, key.id);
    const result = await resolveWidgetContext(key.publicKey, 'https://acme.test');
    expect(result).toEqual({ ok: false, status: 401, error: 'invalid widget key' });
  });

  it('rejects a missing origin header', async () => {
    const key = await createWidgetKey(org, { name: 'o', allowedOrigins: ['https://acme.test'] });
    const result = await resolveWidgetContext(key.publicKey, undefined);
    expect(result).toEqual({ ok: false, status: 403, error: 'origin not allowed' });
  });

  it('rejects an origin not on the allowlist', async () => {
    const key = await createWidgetKey(org, { name: 'o2', allowedOrigins: ['https://acme.test'] });
    const result = await resolveWidgetContext(key.publicKey, 'https://evil.test');
    expect(result).toEqual({ ok: false, status: 403, error: 'origin not allowed' });
  });

  it('requires an exact origin match, not a prefix', async () => {
    // A prefix match would let "https://acme.test.evil.test" impersonate the
    // allowed origin.
    const key = await createWidgetKey(org, { name: 'o3', allowedOrigins: ['https://acme.test'] });
    const result = await resolveWidgetContext(key.publicKey, 'https://acme.test.evil.test');
    expect(result.ok).toBe(false);
  });
});
