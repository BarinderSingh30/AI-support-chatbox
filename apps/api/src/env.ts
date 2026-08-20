import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// The monorepo keeps one .env at the root; workspace scripts run from their own
// directory, so resolve it relative to this file rather than process.cwd().
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: z.string().min(1),
  PUBLIC_DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(768),
  CHAT_MODEL: z.string().default('gemini-2.5-flash'),
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().default('http://localhost:3000'),
  DASHBOARD_URL: z.string().default('http://localhost:5174'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n', z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
