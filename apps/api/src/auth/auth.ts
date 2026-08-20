import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { organization } from 'better-auth/plugins';
import { db } from '../db/client.ts';
import { env } from '../env.ts';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.DASHBOARD_URL],
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});

export type Auth = typeof auth;
