import { buildApp } from './app.ts';
import { env } from './env.ts';

const { app, worker } = await buildApp();

await app.listen({ port: env.PORT, host: '0.0.0.0' });

// Pick up anything a previous process died holding. This is the only place the
// queue is drained without an enqueue triggering it.
const reclaimed = await worker.recover();
if (reclaimed > 0) app.log.warn({ reclaimed }, 'requeued stalled ingestion jobs');
