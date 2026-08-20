import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { authPlugin } from './auth/plugin.ts';
import { documentRoutes } from './modules/documents/routes.ts';
import { createGeminiEmbedder, createLazyEmbedder, type Embedder } from './modules/ingestion/embedder.ts';
import { createGeminiChatProvider } from './llm/gemini.ts';
import { createLazyChatProvider } from './llm/lazy.ts';
import { chatRoutes } from './modules/chat/routes.ts';
import type { ChatProvider } from './llm/provider.ts';
import { createWorker, type Worker } from './modules/ingestion/worker.ts';
import { env } from './env.ts';

export interface AppDeps {
  /** Overridden in tests so ingestion runs without a live API key. */
  embedder?: Embedder;
  chat?: ChatProvider;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  worker: Worker;
}

export async function buildApp(deps: AppDeps = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : env.NODE_ENV === 'development'
          ? { transport: { target: 'pino-pretty' } }
          : true,
  });

  const embedder = deps.embedder ?? createLazyEmbedder(() => createGeminiEmbedder());
  const chat = deps.chat ?? createLazyChatProvider(() => createGeminiChatProvider());
  const worker = createWorker({ embedder });

  await app.register(sensible);
  await app.register(cors, { origin: [env.BETTER_AUTH_URL], credentials: true });
  await app.register(authPlugin);
  await app.register(multipart);
  await app.register(documentRoutes(worker));
  await app.register(chatRoutes({ embedder, chat }));

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  return { app, worker };
}
