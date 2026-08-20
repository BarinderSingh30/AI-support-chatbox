import { eq, inArray, sql } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import {
  chatMessages, chatSessions, documentChunks, documents, messageCitations,
} from '../../db/schema/index.ts';

const EXCERPT_LENGTH = 220;

export interface ConversationSummary {
  id: string;
  visitorId: string | null;
  origin: string | null;
  startedAt: Date;
  lastMessageAt: Date | null;
  messageCount: number;
}

export interface TranscriptCitation {
  n: number;
  documentTitle: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
}

export interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  answered: boolean | null;
  topScore: number | null;
  createdAt: Date;
  citations: TranscriptCitation[];
}

interface ConversationRow {
  id: string;
  visitor_id: string | null;
  origin: string | null;
  started_at: Date;
  last_message_at: Date | null;
  message_count: string;
}

/** Session list for the conversation browser, most recently active first. */
export async function listConversations(
  orgId: string, limit: number, offset: number,
): Promise<ConversationSummary[]> {
  return withTenant(orgId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT s.id, s.visitor_id, s.origin, s.started_at, s.last_message_at,
             count(m.id) AS message_count
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.last_message_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `);
    const rows = (result.rows ?? result) as unknown as ConversationRow[];
    return rows.map((r) => ({
      id: r.id,
      visitorId: r.visitor_id,
      origin: r.origin,
      startedAt: r.started_at,
      lastMessageAt: r.last_message_at,
      messageCount: Number(r.message_count),
    }));
  });
}

/** Full transcript with joined citations, or null if the session isn't this org's. */
export async function getConversation(
  orgId: string, sessionId: string,
): Promise<TranscriptMessage[] | null> {
  return withTenant(orgId, async (tx) => {
    const [session] = await tx.select({ id: chatSessions.id })
      .from(chatSessions).where(eq(chatSessions.id, sessionId));
    if (!session) return null;

    const messages = await tx.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    const citationsByMessage = new Map<string, TranscriptCitation[]>();
    if (messages.length > 0) {
      const citationRows = await tx.select({
        messageId: messageCitations.messageId,
        rank: messageCitations.rank,
        documentTitle: documents.title,
        headingPath: documentChunks.headingPath,
        pageFrom: documentChunks.pageFrom,
        pageTo: documentChunks.pageTo,
        content: documentChunks.content,
      })
        .from(messageCitations)
        .innerJoin(documentChunks, eq(documentChunks.id, messageCitations.chunkId))
        .innerJoin(documents, eq(documents.id, documentChunks.documentId))
        .where(inArray(messageCitations.messageId, messages.map((m) => m.id)))
        .orderBy(messageCitations.rank);

      for (const row of citationRows) {
        const list = citationsByMessage.get(row.messageId) ?? [];
        list.push({
          n: row.rank,
          documentTitle: row.documentTitle,
          headingPath: row.headingPath,
          pageFrom: row.pageFrom,
          pageTo: row.pageTo,
          excerpt: row.content.length > EXCERPT_LENGTH
            ? `${row.content.slice(0, EXCERPT_LENGTH).trimEnd()}…`
            : row.content,
        });
        citationsByMessage.set(row.messageId, list);
      }
    }

    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      answered: m.answered,
      topScore: m.topScore,
      createdAt: m.createdAt,
      citations: citationsByMessage.get(m.id) ?? [],
    }));
  });
}
