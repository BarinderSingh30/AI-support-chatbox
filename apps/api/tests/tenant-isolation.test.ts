import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { documents, organization } from '../src/db/schema/index.ts';

const orgA = `test-a-${randomUUID()}`;
const orgB = `test-b-${randomUUID()}`;

beforeAll(async () => {
  // `organization` is Better Auth's table and is not tenant-scoped, so this
  // insert needs no GUC.
  await db.insert(organization).values([
    { id: orgA, name: 'Acme', slug: orgA, createdAt: new Date() },
    { id: orgB, name: 'Globex', slug: orgB, createdAt: new Date() },
  ]);

  await withTenant(orgA, (tx) =>
    tx.insert(documents).values({
      orgId: orgA, title: 'Acme handbook', sourceType: 'paste', contentHash: randomUUID(),
    }),
  );
  await withTenant(orgB, (tx) =>
    tx.insert(documents).values({
      orgId: orgB, title: 'Globex handbook', sourceType: 'paste', contentHash: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgA));
  await db.delete(organization).where(eq(organization.id, orgB));
  await pool.end();
});

describe('tenant isolation', () => {
  it('sees only its own rows through withTenant', async () => {
    const rows = await withTenant(orgA, (tx) => tx.select().from(documents));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Acme handbook');
  });

  it('cannot reach another tenant even when asked for it explicitly', async () => {
    // The killer case: a query that *tries* to read org B while scoped to org A.
    const rows = await withTenant(orgA, (tx) =>
      tx.select().from(documents).where(eq(documents.orgId, orgB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('returns nothing when the org filter is forgotten entirely', async () => {
    // No withTenant, so app.org_id is unset. This is the mistake RLS exists to
    // catch: without it, this query would return every tenant's documents.
    const rows = await db.select().from(documents);
    expect(rows).toHaveLength(0);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    // Drizzle wraps driver errors, so the Postgres message
    // ("new row violates row-level security policy") sits on the cause chain
    // rather than on .message. Walk it rather than depending on wrapper shape.
    const messages: string[] = [];
    try {
      await withTenant(orgA, (tx) =>
        tx.insert(documents).values({
          orgId: orgB, title: 'smuggled', sourceType: 'paste', contentHash: randomUUID(),
        }),
      );
      throw new Error('insert should have been rejected by RLS');
    } catch (err) {
      for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
    }
    expect(messages.join(' | ')).toMatch(/violates row-level security policy/i);
  });

  it('connects as a role that cannot bypass RLS', async () => {
    const res = await db.execute(
      sql`select current_user::text as usr, rolbypassrls from pg_roles where rolname = current_user`,
    );
    const row = (res.rows ?? res)[0] as { usr: string; rolbypassrls: boolean };
    expect(row.usr).toBe('groundwork_app');
    expect(row.rolbypassrls).toBe(false);
  });
});
