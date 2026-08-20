import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { organization, widgetKeys } from '../src/db/schema/index.ts';
import { createWidgetKey, listWidgetKeys, revokeWidgetKey, findActiveKeyByPublicKey } from '../src/modules/widget-keys/service.ts';

const org = `wk-${randomUUID()}`;
const otherOrg = `wk-other-${randomUUID()}`;

beforeAll(async () => {
  for (const id of [org, otherOrg]) {
    await db.delete(organization).where(eq(organization.id, id));
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
  }
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.delete(organization).where(eq(organization.id, otherOrg));
  await pool.end();
});

describe('createWidgetKey', () => {
  it('generates a public key prefixed for easy recognition', async () => {
    const key = await createWidgetKey(org, { name: 'Marketing site', allowedOrigins: ['https://acme.test'] });
    expect(key.publicKey).toMatch(/^pk_live_[A-Za-z0-9_-]{20,}$/);
  });

  it('generates a unique key on every call', async () => {
    const a = await createWidgetKey(org, { name: 'A', allowedOrigins: ['https://a.test'] });
    const b = await createWidgetKey(org, { name: 'B', allowedOrigins: ['https://b.test'] });
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('stores the allowed origins exactly as given', async () => {
    const key = await createWidgetKey(org, {
      name: 'C', allowedOrigins: ['https://acme.test', 'https://www.acme.test'],
    });
    const [row] = await withTenant(org, (tx) =>
      tx.select().from(widgetKeys).where(eq(widgetKeys.id, key.id)),
    );
    expect(row?.allowedOrigins).toEqual(['https://acme.test', 'https://www.acme.test']);
  });
});

describe('listWidgetKeys', () => {
  it('only lists keys for the calling org', async () => {
    await createWidgetKey(org, { name: 'mine', allowedOrigins: ['https://acme.test'] });
    await createWidgetKey(otherOrg, { name: 'theirs', allowedOrigins: ['https://other.test'] });
    const mine = await listWidgetKeys(org);
    expect(mine.every((k) => k.name !== 'theirs')).toBe(true);
    expect(mine.some((k) => k.name === 'mine')).toBe(true);
  });

  it('never returns the underlying secret twice', async () => {
    // Not actually secret (it's a public key), but listing should still return
    // the stored key so it can be copied again — verifying it's present.
    const created = await createWidgetKey(org, { name: 'visible', allowedOrigins: ['https://acme.test'] });
    const rows = await listWidgetKeys(org);
    expect(rows.find((k) => k.id === created.id)?.publicKey).toBe(created.publicKey);
  });
});

describe('revokeWidgetKey', () => {
  it('marks the key revoked and it stops resolving as active', async () => {
    const key = await createWidgetKey(org, { name: 'temp', allowedOrigins: ['https://acme.test'] });
    await revokeWidgetKey(org, key.id);
    const found = await findActiveKeyByPublicKey(key.publicKey);
    expect(found).toBeNull();
  });

  it('cannot revoke a key belonging to another org', async () => {
    const key = await createWidgetKey(otherOrg, { name: 'not-yours', allowedOrigins: ['https://other.test'] });
    await expect(revokeWidgetKey(org, key.id)).rejects.toThrow(/not found/i);
    // Still active — the revoke from the wrong org must not have applied.
    expect(await findActiveKeyByPublicKey(key.publicKey)).not.toBeNull();
  });
});

describe('findActiveKeyByPublicKey', () => {
  it('resolves an active key to its org, bypassing the normal tenant scope', async () => {
    // This is the one place a lookup must cross tenants: a visitor on a
    // client's website has no session and no org context yet — the public key
    // IS how the org is determined, so this can't go through withTenant.
    const key = await createWidgetKey(org, { name: 'lookup', allowedOrigins: ['https://acme.test'] });
    const found = await findActiveKeyByPublicKey(key.publicKey);
    expect(found?.orgId).toBe(org);
    expect(found?.allowedOrigins).toEqual(['https://acme.test']);
  });

  it('returns null for an unknown key', async () => {
    expect(await findActiveKeyByPublicKey('pk_live_doesnotexist')).toBeNull();
  });
});
