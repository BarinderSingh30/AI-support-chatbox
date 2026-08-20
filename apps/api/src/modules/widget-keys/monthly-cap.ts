import { sql } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';

/**
 * Enforced before dispatch, not reconciled after: a cap that only warns once
 * the bill has already arrived is not a control. Counts user messages sent
 * through this widget key since the first of the current calendar month.
 */
export async function checkMonthlyCap(
  orgId: string,
  widgetKeyId: string,
  cap: number,
): Promise<boolean> {
  const count = await withTenant(orgId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT count(*)::int AS n
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE s.widget_key_id = ${widgetKeyId}
        AND m.role = 'user'
        AND m.created_at >= date_trunc('month', now())
    `);
    const row = ((result.rows ?? result) as Array<{ n: number }>)[0];
    return row?.n ?? 0;
  });

  return count < cap;
}
