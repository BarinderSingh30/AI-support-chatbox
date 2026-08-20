import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { authPlugin } from './auth/plugin.ts';
import { env } from './env.ts';

const app = Fastify({
  logger: env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : true,
});

await app.register(sensible);
await app.register(cors, { origin: [env.BETTER_AUTH_URL], credentials: true });
await app.register(authPlugin);

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
