import {
  pgTable, text, integer, real, boolean, numeric, timestamp, index, primaryKey, bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organization } from './auth.ts';
import { documentChunks } from './documents.ts';

const orgId = () =>
  text('org_id').notNull().references(() => organization.id, { onDelete: 'cascade' });

export const widgetKeys = pgTable(
  'widget_keys',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    orgId: orgId(),
    // Ships to browsers by definition — never a secret. Security comes from the
    // origin allowlist, rate limits, and the monthly cap below.
    publicKey: text('public_key').notNull().unique(),
    name: text('name'),
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
    rateLimitRpm: integer('rate_limit_rpm').notNull().default(20),
    monthlyMsgCap: integer('monthly_msg_cap').notNull().default(1000),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('widget_keys_org_idx').on(t.orgId)],
);

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    orgId: orgId(),
    widgetKeyId: text('widget_key_id').references(() => widgetKeys.id, { onDelete: 'set null' }),
    visitorId: text('visitor_id'),
    origin: text('origin'),
    userAgent: text('user_agent'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  },
  (t) => [index('chat_sessions_org_started_idx').on(t.orgId, t.startedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    orgId: orgId(),
    sessionId: text('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant
    content: text('content').notNull(),
    // false = the relevance gate fired and we answered "I don't know".
    answered: boolean('answered'),
    topScore: real('top_score'),
    latencyMs: integer('latency_ms'),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_messages_session_idx').on(t.sessionId, t.createdAt),
    // Drives the "top unanswered questions" report in the dashboard.
    index('chat_messages_org_answered_idx').on(t.orgId, t.answered),
  ],
);

export const messageCitations = pgTable(
  'message_citations',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => documentChunks.id, { onDelete: 'cascade' }),
    orgId: orgId(),
    rank: integer('rank').notNull(),
    score: real('score'),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.chunkId] })],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgId(),
    kind: text('kind').notNull(), // embed | chat
    model: text('model').notNull(),
    tokens: integer('tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_events_org_created_idx').on(t.orgId, t.createdAt)],
);
