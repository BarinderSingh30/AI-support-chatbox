import { findActiveKeyByPublicKey } from '../modules/widget-keys/service.ts';

export interface WidgetContext {
  ok: true;
  orgId: string;
  widgetKeyId: string;
  rateLimitRpm: number;
  monthlyMsgCap: number;
}

export interface WidgetRejection {
  ok: false;
  status: 401 | 403;
  error: string;
}

/**
 * Resolves a widget request to its organization, or explains why not.
 *
 * Two checks, deliberately in this order and deliberately with different
 * status codes: an unknown/revoked key is 401 (bad credential), while a known
 * key used from an origin it was never issued for is 403 (forbidden action) —
 * the key itself is fine, the site presenting it is not authorized.
 */
export async function resolveWidgetContext(
  publicKey: string | undefined,
  origin: string | undefined,
): Promise<WidgetContext | WidgetRejection> {
  if (!publicKey) return { ok: false, status: 401, error: 'missing widget key' };

  const key = await findActiveKeyByPublicKey(publicKey);
  if (!key) return { ok: false, status: 401, error: 'invalid widget key' };

  // Exact match only — a substring/prefix check would let
  // "https://acme.test.evil.test" pass for an allowlisted "https://acme.test".
  if (!origin || !key.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, error: 'origin not allowed' };
  }

  return {
    ok: true,
    orgId: key.orgId,
    widgetKeyId: key.id,
    rateLimitRpm: key.rateLimitRpm,
    monthlyMsgCap: key.monthlyMsgCap,
  };
}
