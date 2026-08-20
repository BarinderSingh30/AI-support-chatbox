import { pgTable, text, integer, real, jsonb } from 'drizzle-orm/pg-core';
import { organization } from './auth.ts';

export const orgSettings = pgTable('org_settings', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  chatModel: text('chat_model').notNull().default('gemini-2.5-flash'),
  systemPrompt: text('system_prompt'),
  welcomeMessage: text('welcome_message'),
  noAnswerMessage: text('no_answer_message'),
  theme: jsonb('theme'),
  // The relevance gate: below this best-score, we answer "I don't know"
  // without calling the LLM at all.
  minScore: real('min_score').notNull().default(0.35),
  topK: integer('top_k').notNull().default(6),
});
