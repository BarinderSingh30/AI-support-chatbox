import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import {
  chatMessages, documentChunks, documents, messageCitations, organization, orgSettings, usageEvents,
} from '../src/db/schema/index.ts';
import { answerQuestion } from '../src/modules/chat/answer.ts';
import type { ChatProvider, ChatUsage } from '../src/llm/provider.ts';
import type { Embedder } from '../src/modules/ingestion/embedder.ts';

const org = `a-${randomUUID()}`;
const axis = (i: number) => Array.from({ length: 768 }, (_, n) => (n === i ? 1 : 0));

const embedder = (i: number): Embedder => ({
  embedDocuments: async (t) => t.map(() => axis(i)),
  embedQuery: async () => axis(i),
});

/** Records whether it was called at all — that is what the gate test asserts. */
function fakeProvider(text: string, calls = { count: 0 }): ChatProvider & { calls: typeof calls } {
  return {
    calls,
    async *stream(): AsyncGenerator<string, ChatUsage, undefined> {
      calls.count++;
      for (const word of text.split(' ')) yield `${word} `;
      return { inputTokens: 1200, outputTokens: 80 };
    },
  };
}

async function drain(gen: ReturnType<typeof answerQuestion>) {
  const tokens: string[] = [];
  let next = await gen.next();
  while (!next.done) {
    if (next.value.type === 'token') tokens.push(next.value.text);
    next = await gen.next();
  }
  return { text: tokens.join(''), result: next.value };
}

beforeAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.insert(organization).values({ id: org, name: 'A', slug: org, createdAt: new Date() });
  await withTenant(org, async (tx) => {
    await tx.insert(orgSettings).values({
      orgId: org, minScore: 0.5, topK: 4,
      noAnswerMessage: "I couldn't find that in our documentation.",
    });
    const [doc] = await tx.insert(documents).values({
      orgId: org, title: 'Handbook', sourceType: 'md', contentHash: randomUUID(), status: 'ready',
    }).returning();
    await tx.insert(documentChunks).values([
      {
        orgId: org, documentId: doc!.id, chunkIndex: 0,
        content: 'Refunds are issued within 14 days of the returned unit arriving.',
        headingPath: 'Refunds', pageFrom: 2, pageTo: 2, tokenCount: 20, embedding: axis(0),
      },
      {
        orgId: org, documentId: doc!.id, chunkIndex: 1,
        content: 'Shipping is free on orders over fifty dollars.',
        headingPath: 'Shipping', pageFrom: 3, pageTo: 3, tokenCount: 15, embedding: axis(1),
      },
    ]);
  });
});

beforeEach(async () => {
  await withTenant(org, async (tx) => {
    await tx.delete(chatMessages);
    await tx.delete(usageEvents);
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
});

describe('answerQuestion', () => {
  it('answers from retrieved passages and streams tokens', async () => {
    const provider = fakeProvider('Refunds take 14 days [1].');
    const { text, result } = await drain(
      answerQuestion({
        orgId: org, question: 'How long do refunds take?',
        deps: { embedder: embedder(0), chat: provider },
      }),
    );
    expect(text).toContain('14 days');
    expect(result.answered).toBe(true);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.headingPath).toBe('Refunds');
    // The excerpt is what lets a user verify an answer against its actual
    // source without leaving the widget.
    expect(result.citations[0]?.excerpt).toContain('Refunds are issued');
  });

  it('does NOT call the model when nothing relevant is retrieved', async () => {
    // The relevance gate: this is both the cost control and the strongest
    // hallucination control, because the model never sees the question.
    const provider = fakeProvider('should never be produced');
    const { result } = await drain(
      answerQuestion({
        orgId: org, question: 'What is the capital of France?',
        // axis(700) is orthogonal to every stored chunk, so similarity ~0.
        deps: { embedder: embedder(700), chat: provider },
      }),
    );
    expect(provider.calls.count).toBe(0);
    expect(result.answered).toBe(false);
    expect(result.promptTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('uses the tenant own wording when it declines to answer', async () => {
    const { text } = await drain(
      answerQuestion({
        orgId: org, question: 'unrelated',
        deps: { embedder: embedder(700), chat: fakeProvider('x') },
      }),
    );
    expect(text).toContain("I couldn't find that in our documentation.");
  });

  it('treats an INSUFFICIENT_CONTEXT reply as a refusal', async () => {
    const { text, result } = await drain(
      answerQuestion({
        orgId: org, question: 'How long do refunds take?',
        deps: { embedder: embedder(0), chat: fakeProvider('INSUFFICIENT_CONTEXT') },
      }),
    );
    expect(result.answered).toBe(false);
    expect(result.citations).toEqual([]);
    expect(text).not.toContain('INSUFFICIENT_CONTEXT');
  });

  it('refuses an answer that cites nothing', async () => {
    // An uncited claim violates the grounding contract, so it is not shippable
    // even though the model produced fluent text.
    const { result } = await drain(
      answerQuestion({
        orgId: org, question: 'How long do refunds take?',
        deps: { embedder: embedder(0), chat: fakeProvider('Refunds take about two weeks.') },
      }),
    );
    expect(result.answered).toBe(false);
  });

  it('persists the exchange, its citations and its cost', async () => {
    const { result } = await drain(
      answerQuestion({
        orgId: org, question: 'How long do refunds take?',
        deps: { embedder: embedder(0), chat: fakeProvider('Within 14 days [1].') },
      }),
    );

    const rows = await withTenant(org, (tx) => tx.select().from(chatMessages));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.role === 'user')?.content).toBe('How long do refunds take?');
    const assistant = rows.find((r) => r.role === 'assistant')!;
    expect(assistant.answered).toBe(true);
    expect(Number(assistant.costUsd)).toBeGreaterThan(0);
    expect(assistant.promptTokens).toBe(1200);

    const cites = await withTenant(org, (tx) => tx.select().from(messageCitations));
    expect(cites).toHaveLength(1);

    const usage = await withTenant(org, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind).sort()).toEqual(['chat', 'embed']);
    expect(result.sessionId).toBeTruthy();
  });

  it('records a refusal with zero cost so the gate is auditable', async () => {
    await drain(
      answerQuestion({
        orgId: org, question: 'unrelated question',
        deps: { embedder: embedder(700), chat: fakeProvider('x') },
      }),
    );
    const rows = await withTenant(org, (tx) => tx.select().from(chatMessages));
    const assistant = rows.find((r) => r.role === 'assistant')!;
    expect(assistant.answered).toBe(false);
    expect(Number(assistant.costUsd ?? 0)).toBe(0);
    // Embedding the query still costs something; the chat call did not happen.
    const usage = await withTenant(org, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind)).toEqual(['embed']);
  });

  it('continues an existing session when given its id', async () => {
    const first = await drain(
      answerQuestion({
        orgId: org, question: 'How long do refunds take?',
        deps: { embedder: embedder(0), chat: fakeProvider('Within 14 days [1].') },
      }),
    );
    const second = await drain(
      answerQuestion({
        orgId: org, question: 'And shipping?', sessionId: first.result.sessionId,
        deps: { embedder: embedder(1), chat: fakeProvider('Free over fifty dollars [1].') },
      }),
    );
    expect(second.result.sessionId).toBe(first.result.sessionId);
    const rows = await withTenant(org, (tx) => tx.select().from(chatMessages));
    expect(rows).toHaveLength(4);
  });
});
