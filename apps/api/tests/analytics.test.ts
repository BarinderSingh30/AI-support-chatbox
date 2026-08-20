import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { chatMessages, chatSessions, organization, usageEvents } from '../src/db/schema/index.ts';
import { getAnalyticsOverview, getUnansweredQuestions } from '../src/modules/analytics/service.ts';

const org = `an-${randomUUID()}`;
const otherOrg = `an-other-${randomUUID()}`;

beforeAll(async () => {
  await db.insert(organization).values([
    { id: org, name: org, slug: org, createdAt: new Date() },
    { id: otherOrg, name: otherOrg, slug: otherOrg, createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.delete(organization).where(eq(organization.id, otherOrg));
  await pool.end();
});

describe('getAnalyticsOverview', () => {
  it('computes answer rate, totals, and per-day series from this org only', async () => {
    const [session] = await withTenant(org, (tx) =>
      tx.insert(chatSessions).values({ orgId: org }).returning({ id: chatSessions.id }),
    );
    await withTenant(org, (tx) =>
      tx.insert(chatMessages).values([
        { orgId: org, sessionId: session!.id, role: 'assistant', content: 'a1', answered: true },
        { orgId: org, sessionId: session!.id, role: 'assistant', content: 'a2', answered: true },
        { orgId: org, sessionId: session!.id, role: 'assistant', content: 'a3', answered: false },
      ]),
    );
    await withTenant(org, (tx) =>
      tx.insert(usageEvents).values([
        { orgId: org, kind: 'chat', model: 'gemini-2.5-flash', costUsd: '0.001000' },
        { orgId: org, kind: 'embed', model: 'gemini-embedding-001', costUsd: '0.000200' },
      ]),
    );
    const [otherSession] = await withTenant(otherOrg, (tx) =>
      tx.insert(chatSessions).values({ orgId: otherOrg }).returning({ id: chatSessions.id }),
    );
    await withTenant(otherOrg, (tx) =>
      tx.insert(chatMessages).values({
        orgId: otherOrg, sessionId: otherSession!.id, role: 'assistant', content: 'x', answered: true,
      }),
    );

    const overview = await getAnalyticsOverview(org, 30);
    expect(overview.totalMessages).toBe(3);
    expect(overview.answerRate).toBeCloseTo(2 / 3, 5);
    expect(overview.totalCostUsd).toBeCloseTo(0.0012, 6);
    expect(overview.messagesByDay.reduce((sum, d) => sum + d.count, 0)).toBe(3);
  });

  it('excludes messages the gate never scored from the answer rate', async () => {
    const scoped = `an-gate-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });
    const [session] = await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped }).returning({ id: chatSessions.id }),
    );
    // A user message has answered = null; it must not count as an unanswered assistant reply.
    await withTenant(scoped, (tx) =>
      tx.insert(chatMessages).values([
        { orgId: scoped, sessionId: session!.id, role: 'user', content: 'q' },
        { orgId: scoped, sessionId: session!.id, role: 'assistant', content: 'a', answered: true },
      ]),
    );
    const overview = await getAnalyticsOverview(scoped, 30);
    expect(overview.answerRate).toBe(1);
    await db.delete(organization).where(eq(organization.id, scoped));
  });
});

describe('getUnansweredQuestions', () => {
  it('groups repeated unanswered questions by frequency, most common first', async () => {
    const scoped = `an-unans-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });

    for (const q of ['Do you ship to Canada?', 'Do you ship to Canada?', 'What are your hours?']) {
      const [session] = await withTenant(scoped, (tx) =>
        tx.insert(chatSessions).values({ orgId: scoped }).returning({ id: chatSessions.id }),
      );
      await withTenant(scoped, async (tx) => {
        await tx.insert(chatMessages).values({
          orgId: scoped, sessionId: session!.id, role: 'user', content: q,
          createdAt: new Date(Date.now() - 1000),
        });
        await tx.insert(chatMessages).values({
          orgId: scoped, sessionId: session!.id, role: 'assistant', content: "I don't know",
          answered: false, createdAt: new Date(),
        });
      });
    }

    const top = await getUnansweredQuestions(scoped, 30, 10);
    expect(top[0]).toEqual({ content: 'Do you ship to Canada?', frequency: 2 });
    expect(top[1]).toEqual({ content: 'What are your hours?', frequency: 1 });
    await db.delete(organization).where(eq(organization.id, scoped));
  });

  it('excludes a question whose reply was answered', async () => {
    const scoped = `an-answered-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });
    const [session] = await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped }).returning({ id: chatSessions.id }),
    );
    await withTenant(scoped, async (tx) => {
      await tx.insert(chatMessages).values({
        orgId: scoped, sessionId: session!.id, role: 'user', content: 'What is your return policy?',
        createdAt: new Date(Date.now() - 1000),
      });
      await tx.insert(chatMessages).values({
        orgId: scoped, sessionId: session!.id, role: 'assistant', content: '30 days',
        answered: true, createdAt: new Date(),
      });
    });
    expect(await getUnansweredQuestions(scoped, 30, 10)).toEqual([]);
    await db.delete(organization).where(eq(organization.id, scoped));
  });
});
