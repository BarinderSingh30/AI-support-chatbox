import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { withTenant } from '../../db/with-tenant.ts';
import { widgetKeys } from '../../db/schema/index.ts';
import { env } from '../../env.ts';

/** Scoped by migration 0006 to SELECT on widget_keys only, active rows only. */
const publicPool = new pg.Pool({
  connectionString: env.PUBLIC_DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
});

export interface CreateWidgetKeyInput {
  name?: string;
  allowedOrigins: string[];
  rateLimitRpm?: number;
  monthlyMsgCap?: number;
}

export interface WidgetKey {
  id: string;
  publicKey: string;
  name: string | null;
  allowedOrigins: string[];
  rateLimitRpm: number;
  monthlyMsgCap: number;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ActiveWidgetKey {
  id: string;
  orgId: string;
  allowedOrigins: string[];
  rateLimitRpm: number;
  monthlyMsgCap: number;
}

function generatePublicKey(): string {
  // pk_live_ prefix makes the key's purpose recognisable at a glance, the way
  // Stripe-style keys do — useful when a client pastes one into a support ticket.
  return `pk_live_${randomBytes(18).toString('base64url')}`;
}

export async function createWidgetKey(orgId: string, input: CreateWidgetKeyInput): Promise<WidgetKey> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.insert(widgetKeys).values({
      orgId,
      publicKey: generatePublicKey(),
      name: input.name,
      allowedOrigins: input.allowedOrigins,
      rateLimitRpm: input.rateLimitRpm ?? 20,
      monthlyMsgCap: input.monthlyMsgCap ?? 1000,
    }).returning();
    return row as WidgetKey;
  });
}

export async function listWidgetKeys(orgId: string): Promise<WidgetKey[]> {
  return withTenant(orgId, (tx) =>
    tx.select().from(widgetKeys).where(eq(widgetKeys.orgId, orgId)),
  ) as Promise<WidgetKey[]>;
}

export async function revokeWidgetKey(orgId: string, keyId: string): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [row] = await tx.update(widgetKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(widgetKeys.id, keyId), eq(widgetKeys.orgId, orgId)))
      .returning({ id: widgetKeys.id });
    if (!row) throw new Error('widget key not found');
  });
}

/**
 * Resolves a public key to its organization for an anonymous visitor.
 *
 * Deliberately outside withTenant: the caller has no org context yet — this
 * lookup IS what establishes it. Uses the narrowly-scoped public pool rather
 * than the tenant-scoped app pool.
 */
export async function findActiveKeyByPublicKey(publicKey: string): Promise<ActiveWidgetKey | null> {
  const { rows } = await publicPool.query(
    `SELECT id, org_id, allowed_origins, rate_limit_rpm, monthly_msg_cap
     FROM widget_keys WHERE public_key = $1 AND revoked_at IS NULL`,
    [publicKey],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        orgId: row.org_id,
        allowedOrigins: row.allowed_origins,
        rateLimitRpm: row.rate_limit_rpm,
        monthlyMsgCap: row.monthly_msg_cap,
      }
    : null;
}

export { publicPool };
