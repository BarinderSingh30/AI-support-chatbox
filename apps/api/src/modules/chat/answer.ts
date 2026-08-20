import { eq } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import {
  chatMessages, chatSessions, messageCitations, orgSettings, usageEvents,
} from '../../db/schema/index.ts';
import { env } from '../../env.ts';
import { estimateCost } from '../../llm/cost.ts';
import type { ChatProvider } from '../../llm/provider.ts';
import type { Embedder } from '../ingestion/embedder.ts';
import { estimateTokens } from '../ingestion/chunker.ts';
import { hybridSearch, type RetrievedChunk } from '../retrieval/hybrid-search.ts';
import { buildGroundingPrompt, NO_ANSWER_TOKEN } from './grounding-prompt.ts';

const DEFAULTS = {
  // See org_settings.minScore for how this number was measured.
  minScore: 0.65,
  topK: 6,
  noAnswerMessage:
    "I couldn't find an answer to that in the documentation I have access to.",
};

const EXCERPT_LENGTH = 220;

export interface Citation {
  n: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  similarity: number;
  /** Lets a user verify the answer against its actual source in the widget. */
  excerpt: string;
}

export type AnswerEvent =
  | { type: 'token'; text: string }
  | { type: 'citations'; citations: Citation[] };

export interface AnswerResult {
  sessionId: string;
  messageId: string;
  answered: boolean;
  citations: Citation[];
  topScore: number;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface AnswerDeps {
  embedder: Embedder;
  chat: ChatProvider;
}

export interface AnswerInput {
  orgId: string;
  question: string;
  sessionId?: string;
  widgetKeyId?: string;
  visitorId?: string;
  origin?: string;
  userAgent?: string;
  deps: AnswerDeps;
}

/** Pulls [1] / [2][3] markers out of the answer and maps them to chunks. */
function extractCitations(text: string, chunks: RetrievedChunk[]): Citation[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= chunks.length) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b).map((n) => {
    const chunk = chunks[n - 1]!;
    return {
      n,
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      headingPath: chunk.headingPath,
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo,
      similarity: chunk.similarity,
      excerpt:
        chunk.content.length > EXCERPT_LENGTH
          ? `${chunk.content.slice(0, EXCERPT_LENGTH).trimEnd()}…`
          : chunk.content,
    };
  });
}

/**
 * Retrieve, gate, generate, cite, persist.
 *
 * Yields tokens as they arrive and returns the accounting when the stream ends.
 * The gate before the model call is the important part: when retrieval finds
 * nothing above the tenant's threshold, the LLM is never invoked at all. That
 * removes an entire class of hallucination and makes the cheapest queries free.
 */
export async function* answerQuestion(
  input: AnswerInput,
): AsyncGenerator<AnswerEvent, AnswerResult, undefined> {
  const startedAt = Date.now();
  const { orgId, question, deps } = input;

  const settings = await withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
    return row;
  });
  const minScore = settings?.minScore ?? DEFAULTS.minScore;
  const topK = settings?.topK ?? DEFAULTS.topK;
  const model = settings?.chatModel ?? env.CHAT_MODEL;
  const noAnswerMessage = settings?.noAnswerMessage ?? DEFAULTS.noAnswerMessage;

  const sessionId = await ensureSession(input);

  // Embedding the query is unavoidable — it is what the gate is measured on.
  const queryVector = await deps.embedder.embedQuery(question);
  const embedCost = estimateCost(env.EMBEDDING_MODEL, { inputTokens: estimateTokens(question) });
  await recordUsage(orgId, 'embed', env.EMBEDDING_MODEL, estimateTokens(question), embedCost);

  const chunks = await hybridSearch(orgId, { queryVector, queryText: question, topK });
  const topScore = chunks[0]?.similarity ?? 0;

  const userMessageId = await persistMessage(orgId, sessionId, {
    role: 'user', content: question,
  });

  // ─── The relevance gate ──────────────────────────────────────────────────
  if (chunks.length === 0 || topScore < minScore) {
    yield { type: 'token', text: noAnswerMessage };
    yield { type: 'citations', citations: [] };
    const messageId = await persistMessage(orgId, sessionId, {
      role: 'assistant', content: noAnswerMessage, answered: false, topScore,
      model, promptTokens: 0, outputTokens: 0, costUsd: 0,
      latencyMs: Date.now() - startedAt,
    });
    return {
      sessionId, messageId, answered: false, citations: [], topScore,
      promptTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - startedAt,
    };
  }

  const { system, user } = buildGroundingPrompt({
    question, chunks, orgSystemPrompt: settings?.systemPrompt,
  });

  const stream = deps.chat.stream({ system, user, model });
  const buffered: string[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };

  // Buffered rather than streamed straight through: we cannot know whether the
  // model refused, or answered without citing anything, until it finishes — and
  // neither is a response we are willing to show.
  let next = await stream.next();
  while (!next.done) {
    buffered.push(next.value);
    next = await stream.next();
  }
  usage = next.value;

  const raw = buffered.join('').trim();
  const refused = raw.includes(NO_ANSWER_TOKEN);
  const citations = refused ? [] : extractCitations(raw, chunks);
  // An answer with no citation violates the grounding contract, however fluent.
  const answered = !refused && citations.length > 0;
  const finalText = answered ? raw : noAnswerMessage;

  for (const token of finalText.match(/\S+\s*/g) ?? [finalText]) {
    yield { type: 'token', text: token };
  }
  yield { type: 'citations', citations };

  const costUsd = estimateCost(model, usage);
  await recordUsage(orgId, 'chat', model, usage.inputTokens + usage.outputTokens, costUsd);

  const latencyMs = Date.now() - startedAt;
  const messageId = await persistMessage(orgId, sessionId, {
    role: 'assistant', content: finalText, answered, topScore, model,
    promptTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd, latencyMs,
  });

  if (citations.length) {
    await withTenant(orgId, (tx) =>
      tx.insert(messageCitations).values(
        citations.map((c) => ({
          messageId, chunkId: c.chunkId, orgId, rank: c.n, score: c.similarity,
        })),
      ),
    );
  }

  void userMessageId;
  return {
    sessionId, messageId, answered, citations, topScore,
    promptTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd, latencyMs,
  };
}

async function ensureSession(input: AnswerInput): Promise<string> {
  if (input.sessionId) {
    await withTenant(input.orgId, (tx) =>
      tx.update(chatSessions)
        .set({ lastMessageAt: new Date() })
        .where(eq(chatSessions.id, input.sessionId!)),
    );
    return input.sessionId;
  }
  return withTenant(input.orgId, async (tx) => {
    const [session] = await tx.insert(chatSessions).values({
      orgId: input.orgId,
      widgetKeyId: input.widgetKeyId,
      visitorId: input.visitorId,
      origin: input.origin,
      userAgent: input.userAgent,
      lastMessageAt: new Date(),
    }).returning({ id: chatSessions.id });
    return session!.id;
  });
}

interface MessageInput {
  role: 'user' | 'assistant';
  content: string;
  answered?: boolean;
  topScore?: number;
  model?: string;
  promptTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

async function persistMessage(orgId: string, sessionId: string, msg: MessageInput) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.insert(chatMessages).values({
      orgId, sessionId,
      role: msg.role,
      content: msg.content,
      answered: msg.answered,
      topScore: msg.topScore,
      model: msg.model,
      promptTokens: msg.promptTokens,
      outputTokens: msg.outputTokens,
      costUsd: msg.costUsd?.toFixed(6),
      latencyMs: msg.latencyMs,
    }).returning({ id: chatMessages.id });
    return row!.id;
  });
}

async function recordUsage(
  orgId: string, kind: 'embed' | 'chat', model: string, tokens: number, costUsd: number,
) {
  await withTenant(orgId, (tx) =>
    tx.insert(usageEvents).values({ orgId, kind, model, tokens, costUsd: costUsd.toFixed(6) }),
  );
}
