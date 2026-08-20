import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit bundles this config to CJS, so import.meta.dirname is unavailable.
// It always runs with apps/api as cwd.
config({ path: resolve(process.cwd(), '../../.env'), quiet: true });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  // Migrations run as the OWNER role, not the app role.
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL! },
  strict: true,
  verbose: true,
});
