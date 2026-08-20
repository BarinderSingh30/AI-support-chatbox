import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import {
  chatMessages, chatSessions, documentChunks, documents, messageCitations, organization,
} from '../src/db/schema/index.ts';
import { getConversation, listConversations } from '../src/modules/conversations/service.ts';

const org = `conv-${randomUUID()}`;
const otherOrg = `conv-other-${randomUUID()}`;

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

describe('listConversations', () => {
  it('lists only the calling org\'s sessions, most recent first, with a message count', async () => {
    const [mine] = await withTenant(org, (tx) =>
      tx.insert(chatSessions).values({
        orgId: org, visitorId: 'v1', lastMessageAt: new Date('2026-01-02'),
      }).returning({ id: chatSessions.id }),
    );
    await withTenant(org, (tx) =>
      tx.insert(chatMessages).values([
        { orgId: org, sessionId: mine!.id, role: 'user', content: 'hi' },
        { orgId: org, sessionId: mine!.id, role: 'assistant', content: 'hello', answered: true },
      ]),
    );
    await withTenant(otherOrg, (tx) =>
      tx.insert(chatSessions).values({ orgId: otherOrg, visitorId: 'v2' }),
    );

    const rows = await listConversations(org, 50, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(mine!.id);
    expect(rows[0]?.messageCount).toBe(2);
  });

  it('orders sessions with no messages after ones that have them', async () => {
    const scoped = `conv-order-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });

    const [withMsg] = await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped, lastMessageAt: new Date() }).returning({ id: chatSessions.id }),
    );
    await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped, lastMessageAt: null }),
    );

    const rows = await listConversations(scoped, 50, 0);
    expect(rows[0]?.id).toBe(withMsg!.id);

    await db.delete(organization).where(eq(organization.id, scoped));
  });
});

describe('getConversation', () => {
  it('returns the full transcript in order with joined citations', async () => {
    const [doc] = await withTenant(org, (tx) =>
      tx.insert(documents).values({
        orgId: org, title: 'Handbook', sourceType: 'paste', contentHash: randomUUID(),
      }).returning({ id: documents.id }),
    );
    const [chunk] = await withTenant(org, (tx) =>
      tx.insert(documentChunks).values({
        orgId: org, documentId: doc!.id, chunkIndex: 0,
        content: 'Refunds are issued within 14 business days of receipt.',
        headingPath: 'Refunds',
      }).returning({ id: documentChunks.id }),
    );
    const [session] = await withTenant(org, (tx) =>
      tx.insert(chatSessions).values({ orgId: org }).returning({ id: chatSessions.id }),
    );
    const [userMsg] = await withTenant(org, (tx) =>
      tx.insert(chatMessages).values({
        orgId: org, sessionId: session!.id, role: 'user', content: 'How long do refunds take?',
      }).returning({ id: chatMessages.id }),
    );
    const [assistantMsg] = await withTenant(org, (tx) =>
      tx.insert(chatMessages).values({
        orgId: org, sessionId: session!.id, role: 'assistant', content: 'Refunds take 14 days [1].',
        answered: true, topScore: 0.81,
      }).returning({ id: chatMessages.id }),
    );
    await withTenant(org, (tx) =>
      tx.insert(messageCitations).values({
        messageId: assistantMsg!.id, chunkId: chunk!.id, orgId: org, rank: 1, score: 0.81,
      }),
    );

    const transcript = await getConversation(org, session!.id);
    expect(transcript).toHaveLength(2);
    expect(transcript?.[0]?.id).toBe(userMsg!.id);
    expect(transcript?.[0]?.citations).toEqual([]);
    expect(transcript?.[1]?.id).toBe(assistantMsg!.id);
    expect(transcript?.[1]?.citations).toEqual([{
      n: 1,
      documentTitle: 'Handbook',
      headingPath: 'Refunds',
      pageFrom: null,
      pageTo: null,
      excerpt: 'Refunds are issued within 14 business days of receipt.',
    }]);
  });

  it('returns null for a session that does not exist in this org', async () => {
    expect(await getConversation(org, randomUUID())).toBeNull();
  });

  it('cannot read another org\'s session', async () => {
    const [theirs] = await withTenant(otherOrg, (tx) =>
      tx.insert(chatSessions).values({ orgId: otherOrg }).returning({ id: chatSessions.id }),
    );
    expect(await getConversation(org, theirs!.id)).toBeNull();
  });
});
