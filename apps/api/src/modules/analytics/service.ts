import { sql } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';

export interface DailyCount { date: string; count: number }
export interface DailyCost { date: string; costUsd: number }

export interface AnalyticsOverview {
  messagesByDay: DailyCount[];
  costByDay: DailyCost[];
  answerRate: number;
  totalMessages: number;
  totalCostUsd: number;
}

export interface UnansweredQuestion {
  content: string;
  frequency: number;
}

function toDateString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

/**
 * Message volume, spend, and answer rate for the trailing `days` days.
 *
 * `answerRate` only considers assistant messages the relevance gate actually
 * scored (`answered IS NOT NULL`) — a gate that hasn't fired yet must not
 * silently drag the rate down.
 */
export async function getAnalyticsOverview(orgId: string, days: number): Promise<AnalyticsOverview> {
  return withTenant(orgId, async (tx) => {
    const messagesResult = await tx.execute(sql`
      SELECT date_trunc('day', created_at) AS day, count(*) AS count
      FROM chat_messages
      WHERE role = 'assistant' AND created_at >= now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1
    `);
    const costResult = await tx.execute(sql`
      SELECT date_trunc('day', created_at) AS day, coalesce(sum(cost_usd), 0) AS cost_usd
      FROM usage_events
      WHERE created_at >= now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1
    `);
    const totalsResult = await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE answered = true) AS answered_count,
        count(*) FILTER (WHERE answered IS NOT NULL) AS gated_count,
        count(*) AS total_messages
      FROM chat_messages
      WHERE role = 'assistant' AND created_at >= now() - (${days} * interval '1 day')
    `);
    const costTotalResult = await tx.execute(sql`
      SELECT coalesce(sum(cost_usd), 0) AS total_cost_usd
      FROM usage_events
      WHERE created_at >= now() - (${days} * interval '1 day')
    `);

    const messagesByDay = ((messagesResult.rows ?? messagesResult) as unknown as
      { day: Date; count: string }[]).map((r) => ({ date: toDateString(r.day), count: Number(r.count) }));
    const costByDay = ((costResult.rows ?? costResult) as unknown as
      { day: Date; cost_usd: string }[]).map((r) => ({ date: toDateString(r.day), costUsd: Number(r.cost_usd) }));
    const [totals] = (totalsResult.rows ?? totalsResult) as unknown as
      { answered_count: string; gated_count: string; total_messages: string }[];
    const [costTotal] = (costTotalResult.rows ?? costTotalResult) as unknown as
      { total_cost_usd: string }[];

    const gatedCount = Number(totals?.gated_count ?? 0);
    const answeredCount = Number(totals?.answered_count ?? 0);

    return {
      messagesByDay,
      costByDay,
      answerRate: gatedCount > 0 ? answeredCount / gatedCount : 0,
      totalMessages: Number(totals?.total_messages ?? 0),
      totalCostUsd: Number(costTotal?.total_cost_usd ?? 0),
    };
  });
}

/**
 * Top user questions whose paired assistant reply was the "I don't know"
 * fallback, grouped by exact text (not semantic clustering — that belongs to
 * Phase 5's retrieval evals) and ordered by frequency.
 *
 * Pairing uses LEAD() over (session_id, created_at): every user message in
 * this codebase is immediately followed by exactly one assistant reply in
 * the same session (see modules/chat/answer.ts's persistMessage ordering).
 */
export async function getUnansweredQuestions(
  orgId: string, days: number, limit: number,
): Promise<UnansweredQuestion[]> {
  return withTenant(orgId, async (tx) => {
    const result = await tx.execute(sql`
      WITH ordered AS (
        SELECT content, role, session_id, created_at,
               lead(role) OVER (PARTITION BY session_id ORDER BY created_at) AS next_role,
               lead(answered) OVER (PARTITION BY session_id ORDER BY created_at) AS next_answered
        FROM chat_messages
        WHERE created_at >= now() - (${days} * interval '1 day')
      )
      SELECT content, count(*) AS frequency
      FROM ordered
      WHERE role = 'user' AND next_role = 'assistant' AND next_answered = false
      GROUP BY content
      ORDER BY frequency DESC, content ASC
      LIMIT ${limit}
    `);
    const rows = (result.rows ?? result) as unknown as { content: string; frequency: string }[];
    return rows.map((r) => ({ content: r.content, frequency: Number(r.frequency) }));
  });
}
