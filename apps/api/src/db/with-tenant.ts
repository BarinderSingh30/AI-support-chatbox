import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db } from './client.ts';

export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The only sanctioned path to the database.
 *
 * Opens a transaction, pins `app.org_id` for its duration, and hands back a
 * transaction handle. Every RLS policy reads that GUC, so queries inside the
 * callback are physically unable to see another tenant's rows — a forgotten
 * `where(eq(t.orgId, ...))` returns nothing instead of leaking.
 *
 * SET LOCAL is transaction-scoped, so the setting cannot leak to the next
 * checkout of this pooled connection.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!orgId) throw new Error('withTenant requires an orgId');

  return db.transaction(async (tx) => {
    // Parameterised via set_config rather than string-interpolated into SET LOCAL,
    // which does not accept bind parameters.
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
