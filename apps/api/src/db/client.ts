import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.ts';
import * as schema from './schema/index.ts';

/**
 * Connects as the *application* role, which cannot bypass RLS.
 * Short idle timeout so the Postgres compute can suspend between requests —
 * this matters on Neon's free tier, where a pinned-open pool burns the
 * monthly CU-hour budget (see docs/DECISIONS.md).
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
