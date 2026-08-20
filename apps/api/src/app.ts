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
import { widgetKeyRoutes } from './modules/widget-keys/routes.ts';
import { conversationRoutes } from './modules/conversations/routes.ts';
import { analyticsRoutes } from './modules/analytics/routes.ts';
import { orgSettingsRoutes } from './modules/org-settings/routes.ts';
import { publicChatRoutes } from './modules/widget-keys/public-chat-routes.ts';
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

  // Encapsulated: @fastify/cors auto-handles OPTIONS preflight for every route
  // in its scope, and it is configured for the app's own origin only. The
  // public widget routes need to accept any origin (the real gate is the
  // per-key allowlist check, not CORS — see public-chat-routes.ts), so they
  // are registered as a SIBLING of this group, not nested inside it, and
  // manage their own CORS headers entirely.
  await app.register(async (admin) => {
    await admin.register(cors, { origin: [env.BETTER_AUTH_URL, env.DASHBOARD_URL], credentials: true });
    await admin.register(authPlugin);
    await admin.register(multipart);
    await admin.register(documentRoutes(worker));
    await admin.register(chatRoutes({ embedder, chat }));
    await admin.register(widgetKeyRoutes);
    await admin.register(conversationRoutes);
    await admin.register(analyticsRoutes);
    await admin.register(orgSettingsRoutes);
  });

  await app.register(publicChatRoutes({ embedder, chat }));

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  return { app, worker };
}
