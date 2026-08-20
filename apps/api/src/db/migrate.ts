import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '../env.ts';

// Migrations connect as the OWNER role — the app role deliberately cannot
// create or alter objects.
const pool = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 1 });

try {
  await migrate(drizzle(pool), {
    migrationsFolder: resolve(import.meta.dirname, './migrations'),
  });
  console.log('migrations applied');
} finally {
  await pool.end();
}
