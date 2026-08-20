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
  //
  // 0.65 is measured, not guessed. With gemini-embedding-001 at 768 dimensions,
  // unrelated queries against a support corpus score 0.53-0.58 — the floor is
  // nowhere near zero — while genuinely on-topic queries score 0.72-0.79. A
  // lower threshold (the 0.35 this started at) can never fire.
  minScore: real('min_score').notNull().default(0.65),
  topK: integer('top_k').notNull().default(6),
});
