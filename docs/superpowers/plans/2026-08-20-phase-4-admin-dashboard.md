# Phase 4 — Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the operator-facing admin dashboard from ROADMAP.md Phase 4 — document library, conversation browser, analytics, widget configurator with live preview, and widget-key management, gated behind a sign-in flow — as a new `apps/dashboard-app` workspace plus three new API modules.

**Architecture:** Three new session-authenticated API modules (`conversations`, `analytics`, `org-settings`) follow the existing `requireOrg` + `withTenant` + zod-validated-routes pattern from `modules/documents` and `modules/widget-keys`. A new `apps/dashboard-app` React+Vite+Tailwind workspace (same toolchain as `apps/widget-app`) adds `react-router` for navigation and the `better-auth/react` client (with the `organizationClient` plugin) for sign-in/session/org-switching, talking to the API over `fetch` with `credentials: 'include'`.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, Postgres/pgvector, Better Auth 1.7.1 (+ `better-auth/react` client, `organizationClient` plugin), React 19, Vite, Tailwind v4, `react-router` 8.3.0, Vitest + Testing Library, zod 4.

**Spec:** `docs/superpowers/specs/2026-08-20-phase-4-admin-dashboard-design.md`

## Global Constraints

- Every new admin API route sits inside the existing session-authenticated `admin` group in `apps/api/src/app.ts` and uses the `requireOrg` preHandler (`apps/api/src/auth/guard.ts`) — never a bare route.
- Every database read/write goes through `withTenant(orgId, ...)` (`apps/api/src/db/with-tenant.ts`) — no direct `db` access from route/service code. RLS is the tenant boundary, not an application-level `WHERE org_id`.
- New service functions live in a module's own `service.ts`; route handlers in `routes.ts` stay thin (validate → call service → shape response), matching `modules/widget-keys/{service,routes}.ts`.
- API tests live in `apps/api/tests/*.test.ts` (flat, one file per concern) and call service functions directly through `withTenant`, following `apps/api/tests/widget-keys.test.ts` and `apps/api/tests/tenant-isolation.test.ts`. Every new service gets a tenant-isolation case.
- Dashboard-app code follows `apps/widget-app`'s conventions exactly: plain `fetch` + `useEffect`/`useState` for data, no state/query library, Tailwind utility classes only, single quotes, `.ts`/`.tsx` extensions in relative imports, tests in `apps/dashboard-app/tests/*.test.tsx` using Testing Library + `vi.fn()` mocked `fetch`.
- `theme` on `orgSettings` is out of scope — not read, not exposed by `GET/PUT /v1/org-settings`, no editor. (Spec: nothing renders it yet.)
- Analytics charts are hand-rolled SVG (`dataviz` skill), zero charting-library dependency.
- Never commit with `git` directly — print the exact commands and stop (per the user's global CLAUDE.md). Every "Commit" step below is something to print for Barinder to run himself, not to execute.

---

## Task 1: API — DASHBOARD_URL env, CORS, and Better Auth trusted origin

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/app.ts:51-52`
- Modify: `apps/api/src/auth/auth.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `env.DASHBOARD_URL: string` (default `http://localhost:5174`), consumed by every later task that needs to know the dashboard's dev-server origin.

- [ ] **Step 1: Add `DASHBOARD_URL` to the env schema**

In `apps/api/src/env.ts`, add to the zod schema (after `BETTER_AUTH_URL`):

```ts
  DASHBOARD_URL: z.string().default('http://localhost:5174'),
```

- [ ] **Step 2: Allow the dashboard origin in CORS**

In `apps/api/src/app.ts`, change:

```ts
    await admin.register(cors, { origin: [env.BETTER_AUTH_URL], credentials: true });
```

to:

```ts
    await admin.register(cors, { origin: [env.BETTER_AUTH_URL, env.DASHBOARD_URL], credentials: true });
```

- [ ] **Step 3: Trust the dashboard origin in Better Auth's CSRF origin check**

Better Auth rejects cookie-authenticated requests (including sign-in) from any origin not in `trustedOrigins` — CORS alone does not cover this; it's a separate server-side check. In `apps/api/src/auth/auth.ts`, add `trustedOrigins`:

```ts
export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.DASHBOARD_URL],
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});
```

- [ ] **Step 4: Document the new env var**

In `.env.example`, add under the `# ── Auth ──` section, after `BETTER_AUTH_URL`:

```
# Origin the dashboard SPA runs on in dev — must be in Better Auth's
# trustedOrigins and the admin CORS allowlist, or sign-in is rejected.
DASHBOARD_URL="http://localhost:5174"
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @groundwork/api`
Expected: no errors.

- [ ] **Step 6: Commit**

Print for Barinder to run:

```bash
git add apps/api/src/env.ts apps/api/src/app.ts apps/api/src/auth/auth.ts .env.example
git commit -m "feat(api): allow the dashboard origin through CORS and Better Auth's origin check"
```

---

## Task 2: API — conversations module

**Files:**
- Create: `apps/api/src/modules/conversations/service.ts`
- Create: `apps/api/src/modules/conversations/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/tests/conversations.test.ts`

**Interfaces:**
- Consumes: `withTenant<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>` from `apps/api/src/db/with-tenant.ts`; `requireOrg` from `apps/api/src/auth/guard.ts`; schema tables `chatSessions`, `chatMessages`, `messageCitations`, `documentChunks`, `documents` from `apps/api/src/db/schema/index.ts`.
- Produces: `listConversations(orgId: string, limit: number, offset: number): Promise<ConversationSummary[]>`, `getConversation(orgId: string, sessionId: string): Promise<TranscriptMessage[] | null>`, both exported from `modules/conversations/service.ts`, and routes `GET /v1/conversations`, `GET /v1/conversations/:id` registered under the admin group.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/tests/conversations.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import {
  chatMessages, chatSessions, documentChunks, documents, messageCitations, organization,
} from '../src/db/schema/index.ts';
import { getConversation, listConversations } from '../src/modules/conversations/service.ts';

const org = `conv-${randomUUID()}`;
const otherOrg = `conv-other-${randomUUID()}`;

beforeAll(async () => {
  await db.insert(organization).values([
    { id: org, name: org, slug: org, createdAt: new Date() },
    { id: otherOrg, name: otherOrg, slug: otherOrg, createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.delete(organization).where(eq(organization.id, otherOrg));
  await pool.end();
});

describe('listConversations', () => {
  it('lists only the calling org\'s sessions, most recent first, with a message count', async () => {
    const [mine] = await withTenant(org, (tx) =>
      tx.insert(chatSessions).values({
        orgId: org, visitorId: 'v1', lastMessageAt: new Date('2026-01-02'),
      }).returning({ id: chatSessions.id }),
    );
    await withTenant(org, (tx) =>
      tx.insert(chatMessages).values([
        { orgId: org, sessionId: mine!.id, role: 'user', content: 'hi' },
        { orgId: org, sessionId: mine!.id, role: 'assistant', content: 'hello', answered: true },
      ]),
    );
    await withTenant(otherOrg, (tx) =>
      tx.insert(chatSessions).values({ orgId: otherOrg, visitorId: 'v2' }),
    );

    const rows = await listConversations(org, 50, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(mine!.id);
    expect(rows[0]?.messageCount).toBe(2);
  });

  it('orders sessions with no messages after ones that have them', async () => {
    const scoped = `conv-order-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });

    const [withMsg] = await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped, lastMessageAt: new Date() }).returning({ id: chatSessions.id }),
    );
    await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped, lastMessageAt: null }),
    );

    const rows = await listConversations(scoped, 50, 0);
    expect(rows[0]?.id).toBe(withMsg!.id);

    await db.delete(organization).where(eq(organization.id, scoped));
  });
});

describe('getConversation', () => {
  it('returns the full transcript in order with joined citations', async () => {
    const [doc] = await withTenant(org, (tx) =>
      tx.insert(documents).values({
        orgId: org, title: 'Handbook', sourceType: 'paste', contentHash: randomUUID(),
      }).returning({ id: documents.id }),
    );
    const [chunk] = await withTenant(org, (tx) =>
      tx.insert(documentChunks).values({
        orgId: org, documentId: doc!.id, chunkIndex: 0,
        content: 'Refunds are issued within 14 business days of receipt.',
        headingPath: 'Refunds',
      }).returning({ id: documentChunks.id }),
    );
    const [session] = await withTenant(org, (tx) =>
      tx.insert(chatSessions).values({ orgId: org }).returning({ id: chatSessions.id }),
    );
    const [userMsg] = await withTenant(org, (tx) =>
      tx.insert(chatMessages).values({
        orgId: org, sessionId: session!.id, role: 'user', content: 'How long do refunds take?',
      }).returning({ id: chatMessages.id }),
    );
    const [assistantMsg] = await withTenant(org, (tx) =>
      tx.insert(chatMessages).values({
        orgId: org, sessionId: session!.id, role: 'assistant', content: 'Refunds take 14 days [1].',
        answered: true, topScore: 0.81,
      }).returning({ id: chatMessages.id }),
    );
    await withTenant(org, (tx) =>
      tx.insert(messageCitations).values({
        messageId: assistantMsg!.id, chunkId: chunk!.id, orgId: org, rank: 1, score: 0.81,
      }),
    );

    const transcript = await getConversation(org, session!.id);
    expect(transcript).toHaveLength(2);
    expect(transcript?.[0]?.id).toBe(userMsg!.id);
    expect(transcript?.[0]?.citations).toEqual([]);
    expect(transcript?.[1]?.id).toBe(assistantMsg!.id);
    expect(transcript?.[1]?.citations).toEqual([{
      n: 1,
      documentTitle: 'Handbook',
      headingPath: 'Refunds',
      pageFrom: null,
      pageTo: null,
      excerpt: 'Refunds are issued within 14 business days of receipt.',
    }]);
  });

  it('returns null for a session that does not exist in this org', async () => {
    expect(await getConversation(org, randomUUID())).toBeNull();
  });

  it('cannot read another org\'s session', async () => {
    const [theirs] = await withTenant(otherOrg, (tx) =>
      tx.insert(chatSessions).values({ orgId: otherOrg }).returning({ id: chatSessions.id }),
    );
    expect(await getConversation(org, theirs!.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/api -- conversations.test.ts`
Expected: FAIL — `Cannot find module '../src/modules/conversations/service.ts'`.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/conversations/service.ts`:

```ts
import { eq, inArray, sql } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import {
  chatMessages, chatSessions, documentChunks, documents, messageCitations,
} from '../../db/schema/index.ts';

const EXCERPT_LENGTH = 220;

export interface ConversationSummary {
  id: string;
  visitorId: string | null;
  origin: string | null;
  startedAt: Date;
  lastMessageAt: Date | null;
  messageCount: number;
}

export interface TranscriptCitation {
  n: number;
  documentTitle: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
}

export interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  answered: boolean | null;
  topScore: number | null;
  createdAt: Date;
  citations: TranscriptCitation[];
}

interface ConversationRow {
  id: string;
  visitor_id: string | null;
  origin: string | null;
  started_at: Date;
  last_message_at: Date | null;
  message_count: string;
}

/** Session list for the conversation browser, most recently active first. */
export async function listConversations(
  orgId: string, limit: number, offset: number,
): Promise<ConversationSummary[]> {
  return withTenant(orgId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT s.id, s.visitor_id, s.origin, s.started_at, s.last_message_at,
             count(m.id) AS message_count
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.last_message_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `);
    const rows = (result.rows ?? result) as unknown as ConversationRow[];
    return rows.map((r) => ({
      id: r.id,
      visitorId: r.visitor_id,
      origin: r.origin,
      startedAt: r.started_at,
      lastMessageAt: r.last_message_at,
      messageCount: Number(r.message_count),
    }));
  });
}

/** Full transcript with joined citations, or null if the session isn't this org's. */
export async function getConversation(
  orgId: string, sessionId: string,
): Promise<TranscriptMessage[] | null> {
  return withTenant(orgId, async (tx) => {
    const [session] = await tx.select({ id: chatSessions.id })
      .from(chatSessions).where(eq(chatSessions.id, sessionId));
    if (!session) return null;

    const messages = await tx.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    const citationsByMessage = new Map<string, TranscriptCitation[]>();
    if (messages.length > 0) {
      const citationRows = await tx.select({
        messageId: messageCitations.messageId,
        rank: messageCitations.rank,
        documentTitle: documents.title,
        headingPath: documentChunks.headingPath,
        pageFrom: documentChunks.pageFrom,
        pageTo: documentChunks.pageTo,
        content: documentChunks.content,
      })
        .from(messageCitations)
        .innerJoin(documentChunks, eq(documentChunks.id, messageCitations.chunkId))
        .innerJoin(documents, eq(documents.id, documentChunks.documentId))
        .where(inArray(messageCitations.messageId, messages.map((m) => m.id)))
        .orderBy(messageCitations.rank);

      for (const row of citationRows) {
        const list = citationsByMessage.get(row.messageId) ?? [];
        list.push({
          n: row.rank,
          documentTitle: row.documentTitle,
          headingPath: row.headingPath,
          pageFrom: row.pageFrom,
          pageTo: row.pageTo,
          excerpt: row.content.length > EXCERPT_LENGTH
            ? `${row.content.slice(0, EXCERPT_LENGTH).trimEnd()}…`
            : row.content,
        });
        citationsByMessage.set(row.messageId, list);
      }
    }

    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      answered: m.answered,
      topScore: m.topScore,
      createdAt: m.createdAt,
      citations: citationsByMessage.get(m.id) ?? [],
    }));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/api -- conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the thin routes**

Create `apps/api/src/modules/conversations/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../../auth/guard.ts';
import { getConversation, listConversations } from './service.ts';

function parseListQuery(query: unknown): { limit: number; offset: number } {
  const q = query as { limit?: string; offset?: string };
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { limit, offset };
}

/** Admin-side conversation browser: session-authenticated, tenant-scoped, read-only. */
export async function conversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.get('/v1/conversations', async (req) => {
    const { limit, offset } = parseListQuery(req.query);
    return listConversations(req.orgId!, limit, offset);
  });

  app.get('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const messages = await getConversation(req.orgId!, id);
    return messages
      ? reply.send({ id, messages })
      : reply.code(404).send({ error: 'conversation not found' });
  });
}
```

- [ ] **Step 6: Register the routes**

In `apps/api/src/app.ts`, add the import:

```ts
import { conversationRoutes } from './modules/conversations/routes.ts';
```

and register it alongside the existing admin modules:

```ts
    await admin.register(widgetKeyRoutes);
    await admin.register(conversationRoutes);
```

- [ ] **Step 7: Full API test run and typecheck**

Run: `npm run test -w @groundwork/api` and `npm run typecheck -w @groundwork/api`
Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

Print for Barinder to run:

```bash
git add apps/api/src/modules/conversations apps/api/src/app.ts apps/api/tests/conversations.test.ts
git commit -m "feat(api): admin conversation browser endpoints"
```

---

## Task 3: API — analytics module (overview + unanswered questions)

**Files:**
- Create: `apps/api/src/modules/analytics/service.ts`
- Create: `apps/api/src/modules/analytics/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/tests/analytics.test.ts`

**Interfaces:**
- Consumes: same `withTenant`/`requireOrg` as Task 2; schema tables `chatMessages`, `usageEvents`.
- Produces: `getAnalyticsOverview(orgId: string, days: number): Promise<AnalyticsOverview>`, `getUnansweredQuestions(orgId: string, days: number, limit: number): Promise<UnansweredQuestion[]>` from `modules/analytics/service.ts`; routes `GET /v1/analytics/overview`, `GET /v1/analytics/unanswered`.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/tests/analytics.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { withTenant } from '../src/db/with-tenant.ts';
import { chatMessages, chatSessions, organization, usageEvents } from '../src/db/schema/index.ts';
import { getAnalyticsOverview, getUnansweredQuestions } from '../src/modules/analytics/service.ts';

const org = `an-${randomUUID()}`;
const otherOrg = `an-other-${randomUUID()}`;

beforeAll(async () => {
  await db.insert(organization).values([
    { id: org, name: org, slug: org, createdAt: new Date() },
    { id: otherOrg, name: otherOrg, slug: otherOrg, createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await db.delete(organization).where(eq(organization.id, otherOrg));
  await pool.end();
});

describe('getAnalyticsOverview', () => {
  it('computes answer rate, totals, and per-day series from this org only', async () => {
    const [session] = await withTenant(org, (tx) =>
      tx.insert(chatSessions).values({ orgId: org }).returning({ id: chatSessions.id }),
    );
    await withTenant(org, (tx) =>
      tx.insert(chatMessages).values([
        { orgId: org, sessionId: session!.id, role: 'assistant', content: 'a1', answered: true },
        { orgId: org, sessionId: session!.id, role: 'assistant', content: 'a2', answered: true },
        { orgId: org, sessionId: session!.id, role: 'assistant', content: 'a3', answered: false },
      ]),
    );
    await withTenant(org, (tx) =>
      tx.insert(usageEvents).values([
        { orgId: org, kind: 'chat', model: 'gemini-2.5-flash', costUsd: '0.001000' },
        { orgId: org, kind: 'embed', model: 'gemini-embedding-001', costUsd: '0.000200' },
      ]),
    );
    const [otherSession] = await withTenant(otherOrg, (tx) =>
      tx.insert(chatSessions).values({ orgId: otherOrg }).returning({ id: chatSessions.id }),
    );
    await withTenant(otherOrg, (tx) =>
      tx.insert(chatMessages).values({
        orgId: otherOrg, sessionId: otherSession!.id, role: 'assistant', content: 'x', answered: true,
      }),
    );

    const overview = await getAnalyticsOverview(org, 30);
    expect(overview.totalMessages).toBe(3);
    expect(overview.answerRate).toBeCloseTo(2 / 3, 5);
    expect(overview.totalCostUsd).toBeCloseTo(0.0012, 6);
    expect(overview.messagesByDay.reduce((sum, d) => sum + d.count, 0)).toBe(3);
  });

  it('excludes messages the gate never scored from the answer rate', async () => {
    const scoped = `an-gate-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });
    const [session] = await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped }).returning({ id: chatSessions.id }),
    );
    // A user message has answered = null; it must not count as an unanswered assistant reply.
    await withTenant(scoped, (tx) =>
      tx.insert(chatMessages).values([
        { orgId: scoped, sessionId: session!.id, role: 'user', content: 'q' },
        { orgId: scoped, sessionId: session!.id, role: 'assistant', content: 'a', answered: true },
      ]),
    );
    const overview = await getAnalyticsOverview(scoped, 30);
    expect(overview.answerRate).toBe(1);
    await db.delete(organization).where(eq(organization.id, scoped));
  });
});

describe('getUnansweredQuestions', () => {
  it('groups repeated unanswered questions by frequency, most common first', async () => {
    const scoped = `an-unans-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });

    for (const q of ['Do you ship to Canada?', 'Do you ship to Canada?', 'What are your hours?']) {
      const [session] = await withTenant(scoped, (tx) =>
        tx.insert(chatSessions).values({ orgId: scoped }).returning({ id: chatSessions.id }),
      );
      await withTenant(scoped, async (tx) => {
        await tx.insert(chatMessages).values({
          orgId: scoped, sessionId: session!.id, role: 'user', content: q,
          createdAt: new Date(Date.now() - 1000),
        });
        await tx.insert(chatMessages).values({
          orgId: scoped, sessionId: session!.id, role: 'assistant', content: "I don't know",
          answered: false, createdAt: new Date(),
        });
      });
    }

    const top = await getUnansweredQuestions(scoped, 30, 10);
    expect(top[0]).toEqual({ content: 'Do you ship to Canada?', frequency: 2 });
    expect(top[1]).toEqual({ content: 'What are your hours?', frequency: 1 });
    await db.delete(organization).where(eq(organization.id, scoped));
  });

  it('excludes a question whose reply was answered', async () => {
    const scoped = `an-answered-${randomUUID()}`;
    await db.insert(organization).values({ id: scoped, name: scoped, slug: scoped, createdAt: new Date() });
    const [session] = await withTenant(scoped, (tx) =>
      tx.insert(chatSessions).values({ orgId: scoped }).returning({ id: chatSessions.id }),
    );
    await withTenant(scoped, async (tx) => {
      await tx.insert(chatMessages).values({
        orgId: scoped, sessionId: session!.id, role: 'user', content: 'What is your return policy?',
        createdAt: new Date(Date.now() - 1000),
      });
      await tx.insert(chatMessages).values({
        orgId: scoped, sessionId: session!.id, role: 'assistant', content: '30 days',
        answered: true, createdAt: new Date(),
      });
    });
    expect(await getUnansweredQuestions(scoped, 30, 10)).toEqual([]);
    await db.delete(organization).where(eq(organization.id, scoped));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/api -- analytics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/analytics/service.ts`:

```ts
import { sql } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';

export interface DailyCount { date: string; count: number }
export interface DailyCost { date: string; costUsd: number }

export interface AnalyticsOverview {
  messagesByDay: DailyCount[];
  costByDay: DailyCost[];
  answerRate: number;
  totalMessages: number;
  totalCostUsd: number;
}

export interface UnansweredQuestion {
  content: string;
  frequency: number;
}

function toDateString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

/**
 * Message volume, spend, and answer rate for the trailing `days` days.
 *
 * `answerRate` only considers assistant messages the relevance gate actually
 * scored (`answered IS NOT NULL`) — a gate that hasn't fired yet must not
 * silently drag the rate down.
 */
export async function getAnalyticsOverview(orgId: string, days: number): Promise<AnalyticsOverview> {
  return withTenant(orgId, async (tx) => {
    const messagesResult = await tx.execute(sql`
      SELECT date_trunc('day', created_at) AS day, count(*) AS count
      FROM chat_messages
      WHERE role = 'assistant' AND created_at >= now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1
    `);
    const costResult = await tx.execute(sql`
      SELECT date_trunc('day', created_at) AS day, coalesce(sum(cost_usd), 0) AS cost_usd
      FROM usage_events
      WHERE created_at >= now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1
    `);
    const totalsResult = await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE answered = true) AS answered_count,
        count(*) FILTER (WHERE answered IS NOT NULL) AS gated_count,
        count(*) AS total_messages
      FROM chat_messages
      WHERE role = 'assistant' AND created_at >= now() - (${days} * interval '1 day')
    `);
    const costTotalResult = await tx.execute(sql`
      SELECT coalesce(sum(cost_usd), 0) AS total_cost_usd
      FROM usage_events
      WHERE created_at >= now() - (${days} * interval '1 day')
    `);

    const messagesByDay = ((messagesResult.rows ?? messagesResult) as unknown as
      { day: Date; count: string }[]).map((r) => ({ date: toDateString(r.day), count: Number(r.count) }));
    const costByDay = ((costResult.rows ?? costResult) as unknown as
      { day: Date; cost_usd: string }[]).map((r) => ({ date: toDateString(r.day), costUsd: Number(r.cost_usd) }));
    const [totals] = (totalsResult.rows ?? totalsResult) as unknown as
      { answered_count: string; gated_count: string; total_messages: string }[];
    const [costTotal] = (costTotalResult.rows ?? costTotalResult) as unknown as
      { total_cost_usd: string }[];

    const gatedCount = Number(totals?.gated_count ?? 0);
    const answeredCount = Number(totals?.answered_count ?? 0);

    return {
      messagesByDay,
      costByDay,
      answerRate: gatedCount > 0 ? answeredCount / gatedCount : 0,
      totalMessages: Number(totals?.total_messages ?? 0),
      totalCostUsd: Number(costTotal?.total_cost_usd ?? 0),
    };
  });
}

/**
 * Top user questions whose paired assistant reply was the "I don't know"
 * fallback, grouped by exact text (not semantic clustering — that belongs to
 * Phase 5's retrieval evals) and ordered by frequency.
 *
 * Pairing uses LEAD() over (session_id, created_at): every user message in
 * this codebase is immediately followed by exactly one assistant reply in
 * the same session (see modules/chat/answer.ts's persistMessage ordering).
 */
export async function getUnansweredQuestions(
  orgId: string, days: number, limit: number,
): Promise<UnansweredQuestion[]> {
  return withTenant(orgId, async (tx) => {
    const result = await tx.execute(sql`
      WITH ordered AS (
        SELECT content, role, session_id, created_at,
               lead(role) OVER (PARTITION BY session_id ORDER BY created_at) AS next_role,
               lead(answered) OVER (PARTITION BY session_id ORDER BY created_at) AS next_answered
        FROM chat_messages
        WHERE created_at >= now() - (${days} * interval '1 day')
      )
      SELECT content, count(*) AS frequency
      FROM ordered
      WHERE role = 'user' AND next_role = 'assistant' AND next_answered = false
      GROUP BY content
      ORDER BY frequency DESC, content ASC
      LIMIT ${limit}
    `);
    const rows = (result.rows ?? result) as unknown as { content: string; frequency: string }[];
    return rows.map((r) => ({ content: r.content, frequency: Number(r.frequency) }));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/api -- analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the thin routes**

Create `apps/api/src/modules/analytics/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../../auth/guard.ts';
import { getAnalyticsOverview, getUnansweredQuestions } from './service.ts';

function parseDays(query: unknown): number {
  const q = query as { days?: string };
  const days = Number(q.days) || 30;
  return Math.min(Math.max(days, 1), 365);
}

/** Admin-side analytics: session-authenticated, tenant-scoped, read-only. */
export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.get('/v1/analytics/overview', async (req) =>
    getAnalyticsOverview(req.orgId!, parseDays(req.query)));

  app.get('/v1/analytics/unanswered', async (req) => {
    const days = parseDays(req.query);
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    return getUnansweredQuestions(req.orgId!, days, limit);
  });
}
```

- [ ] **Step 6: Register the routes**

In `apps/api/src/app.ts`, add the import and registration:

```ts
import { analyticsRoutes } from './modules/analytics/routes.ts';
```

```ts
    await admin.register(conversationRoutes);
    await admin.register(analyticsRoutes);
```

- [ ] **Step 7: Full API test run and typecheck**

Run: `npm run test -w @groundwork/api` and `npm run typecheck -w @groundwork/api`
Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

Print for Barinder to run:

```bash
git add apps/api/src/modules/analytics apps/api/src/app.ts apps/api/tests/analytics.test.ts
git commit -m "feat(api): admin analytics overview and unanswered-questions endpoints"
```

---

## Task 4: API — org-settings module

**Files:**
- Create: `apps/api/src/modules/org-settings/service.ts`
- Create: `apps/api/src/modules/org-settings/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/tests/org-settings.test.ts`

**Interfaces:**
- Consumes: `withTenant`/`requireOrg`; `orgSettings` table from `apps/api/src/db/schema/index.ts`.
- Produces: `getOrgSettings(orgId: string): Promise<OrgSettingsView>`, `upsertOrgSettings(orgId: string, update: OrgSettingsUpdate): Promise<OrgSettingsView>` from `modules/org-settings/service.ts`; routes `GET /v1/org-settings`, `PUT /v1/org-settings`.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/tests/org-settings.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.ts';
import { organization } from '../src/db/schema/index.ts';
import { getOrgSettings, upsertOrgSettings } from '../src/modules/org-settings/service.ts';

const org = `os-${randomUUID()}`;

beforeAll(async () => {
  await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, org));
  await pool.end();
});

describe('getOrgSettings', () => {
  it('returns sensible defaults for a brand-new org with no row yet', async () => {
    const settings = await getOrgSettings(org);
    expect(settings.welcomeMessage).toBe('Hi! Ask me anything.');
    expect(settings.suggestedQuestions).toEqual([]);
    expect(settings.minScore).toBe(0.65);
    expect(settings.topK).toBe(6);
  });
});

describe('upsertOrgSettings', () => {
  it('creates a row on first write and returns the merged view', async () => {
    const updated = await upsertOrgSettings(org, {
      welcomeMessage: 'Welcome to Acme support!',
      suggestedQuestions: ['What are your hours?'],
    });
    expect(updated.welcomeMessage).toBe('Welcome to Acme support!');
    expect(updated.suggestedQuestions).toEqual(['What are your hours?']);
    // Untouched fields keep their defaults.
    expect(updated.minScore).toBe(0.65);
  });

  it('updates only the given fields on a second write, keeping the rest', async () => {
    await upsertOrgSettings(org, { welcomeMessage: 'First' });
    const updated = await upsertOrgSettings(org, { minScore: 0.7 });
    expect(updated.welcomeMessage).toBe('First');
    expect(updated.minScore).toBe(0.7);
  });

  it('persists across reads', async () => {
    await upsertOrgSettings(org, { topK: 8 });
    const settings = await getOrgSettings(org);
    expect(settings.topK).toBe(8);
  });

  it('accepts an explicit null to clear systemPrompt', async () => {
    // The dashboard's widget configurator (Task 12) round-trips the whole
    // settings object on every save, including an unset systemPrompt as
    // `null` — not omitted — so the update path must accept null, not just
    // `string | undefined`.
    await upsertOrgSettings(org, { systemPrompt: 'Be extra polite.' });
    const cleared = await upsertOrgSettings(org, { systemPrompt: null });
    expect(cleared.systemPrompt).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/api -- org-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/org-settings/service.ts`:

```ts
import { eq } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import { orgSettings } from '../../db/schema/index.ts';

const DEFAULTS = {
  welcomeMessage: 'Hi! Ask me anything.',
  suggestedQuestions: [] as string[],
  systemPrompt: null as string | null,
  noAnswerMessage: "I couldn't find an answer to that in the documentation I have access to.",
  minScore: 0.65,
  topK: 6,
};

export interface OrgSettingsView {
  welcomeMessage: string;
  suggestedQuestions: string[];
  systemPrompt: string | null;
  noAnswerMessage: string;
  minScore: number;
  topK: number;
}

export interface OrgSettingsUpdate {
  welcomeMessage?: string;
  suggestedQuestions?: string[];
  // Nullable, not just optional: the widget configurator (Task 12) round-trips
  // the full settings object on every save, including an unset systemPrompt as
  // `null` (its GET default) — the update type has to accept that explicitly,
  // not just "field omitted".
  systemPrompt?: string | null;
  noAnswerMessage?: string;
  minScore?: number;
  topK?: number;
}

function toView(row: typeof orgSettings.$inferSelect | undefined): OrgSettingsView {
  return {
    welcomeMessage: row?.welcomeMessage ?? DEFAULTS.welcomeMessage,
    suggestedQuestions: row?.suggestedQuestions ?? DEFAULTS.suggestedQuestions,
    systemPrompt: row?.systemPrompt ?? DEFAULTS.systemPrompt,
    noAnswerMessage: row?.noAnswerMessage ?? DEFAULTS.noAnswerMessage,
    minScore: row?.minScore ?? DEFAULTS.minScore,
    topK: row?.topK ?? DEFAULTS.topK,
  };
}

/** Widget-configurator-facing settings; a brand-new org has no row yet. */
export async function getOrgSettings(orgId: string): Promise<OrgSettingsView> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
    return toView(row);
  });
}

/** Upserts only the given fields; a first write creates the row lazily. */
export async function upsertOrgSettings(
  orgId: string, update: OrgSettingsUpdate,
): Promise<OrgSettingsView> {
  return withTenant(orgId, async (tx) => {
    const [existing] = await tx.select({ orgId: orgSettings.orgId })
      .from(orgSettings).where(eq(orgSettings.orgId, orgId));

    if (existing) {
      await tx.update(orgSettings).set(update).where(eq(orgSettings.orgId, orgId));
    } else {
      await tx.insert(orgSettings).values({ orgId, ...update });
    }

    const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
    return toView(row);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/api -- org-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the thin routes**

Create `apps/api/src/modules/org-settings/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../../auth/guard.ts';
import { getOrgSettings, upsertOrgSettings } from './service.ts';

const updateSchema = z.object({
  welcomeMessage: z.string().min(1).max(2000).optional(),
  suggestedQuestions: z.array(z.string().min(1).max(300)).max(10).optional(),
  // .nullable(): the dashboard's widget configurator (Task 12) sends the full
  // settings object on every save, and an org with no system prompt set has
  // this as `null` (see GET's default) — not merely absent from the body.
  // Without .nullable() here, every save from a fresh org fails validation.
  systemPrompt: z.string().max(4000).nullable().optional(),
  noAnswerMessage: z.string().min(1).max(2000).optional(),
  minScore: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(20).optional(),
});

/** Admin-side widget configurator backing store: session-authenticated, tenant-scoped. */
export async function orgSettingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  app.get('/v1/org-settings', async (req) => getOrgSettings(req.orgId!));

  app.put('/v1/org-settings', async (req, reply) => {
    const body = updateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });
    return upsertOrgSettings(req.orgId!, body.data);
  });
}
```

- [ ] **Step 6: Register the routes**

In `apps/api/src/app.ts`, add the import and registration:

```ts
import { orgSettingsRoutes } from './modules/org-settings/routes.ts';
```

```ts
    await admin.register(analyticsRoutes);
    await admin.register(orgSettingsRoutes);
```

- [ ] **Step 7: Full API test run and typecheck**

Run: `npm run test -w @groundwork/api` and `npm run typecheck -w @groundwork/api`
Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

Print for Barinder to run:

```bash
git add apps/api/src/modules/org-settings apps/api/src/app.ts apps/api/tests/org-settings.test.ts
git commit -m "feat(api): admin org-settings endpoints backing the widget configurator"
```

---

## Task 5: dashboard-app — workspace scaffold

**Files:**
- Create: `apps/dashboard-app/package.json`
- Create: `apps/dashboard-app/tsconfig.json`
- Create: `apps/dashboard-app/tsconfig.build.json`
- Create: `apps/dashboard-app/vite.config.ts`
- Create: `apps/dashboard-app/index.html`
- Create: `apps/dashboard-app/src/index.css`
- Create: `apps/dashboard-app/src/main.tsx`
- Create: `apps/dashboard-app/src/App.tsx`
- Create: `apps/dashboard-app/tests/setup.ts`
- Create: `apps/dashboard-app/.env.example`

**Interfaces:**
- Produces: a buildable, testable `@groundwork/dashboard-app` workspace on port 5174 with a placeholder `App` component, ready for later tasks to fill in. `import.meta.env.VITE_API_URL` is the convention every later `lib/api.ts`/`lib/auth-client.ts` task reads from.

- [ ] **Step 1: Write the workspace manifest**

Create `apps/dashboard-app/package.json`:

```json
{
  "name": "@groundwork/dashboard-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "NODE_OPTIONS=--no-experimental-webstorage vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json",
    "test": "NODE_OPTIONS=--no-experimental-webstorage vitest run"
  },
  "dependencies": {
    "better-auth": "1.7.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-router": "8.3.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.5",
    "@types/react": "19.2.15",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.1.0",
    "@tailwindcss/vite": "4.3.3",
    "tailwindcss": "4.3.3",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11",
    "jsdom": "30.0.1"
  }
}
```

- [ ] **Step 2: Write the TypeScript configs**

Create `apps/dashboard-app/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true, "jsx": "react-jsx", "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["vite/client"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

Create `apps/dashboard-app/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src", "outDir": "./dist", "jsx": "react-jsx",
    "lib": ["es2023", "dom", "dom.iterable"], "types": ["vite/client"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the Vite config**

Create `apps/dashboard-app/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'] },
});
```

- [ ] **Step 4: Write the HTML shell, CSS entry, and test setup**

Create `apps/dashboard-app/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Groundwork Dashboard</title>
  </head>
  <body class="m-0 h-screen w-screen overflow-hidden">
    <div id="root" class="h-full w-full"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/dashboard-app/src/index.css`:

```css
@import "tailwindcss";
```

Create `apps/dashboard-app/tests/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: Write a placeholder App and entrypoint**

Create `apps/dashboard-app/src/App.tsx`:

```tsx
export function App() {
  return <div className="p-8 font-sans text-gray-500">Groundwork dashboard — under construction.</div>;
}
```

Create `apps/dashboard-app/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Document the dashboard's API URL env var**

Create `apps/dashboard-app/.env.example`:

```
# The API's own origin (Fastify's PORT/env.ts). Vite only exposes VITE_-
# prefixed vars to client code; copy this to .env and adjust if the API
# doesn't run on the default port.
VITE_API_URL="http://localhost:3000"
```

- [ ] **Step 7: Install and verify the workspace builds, typechecks, and dev-serves**

Run: `npm install` (from repo root — picks up the new workspace via the `apps/*` glob)
Run: `npm run typecheck -w @groundwork/dashboard-app`
Run: `npm run build -w @groundwork/dashboard-app`
Expected: install succeeds, typecheck is clean, build produces `apps/dashboard-app/dist/`.

- [ ] **Step 8: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app package-lock.json
git commit -m "feat(dashboard): scaffold the dashboard-app workspace"
```

---

## Task 6: dashboard-app — API client library

**Files:**
- Create: `apps/dashboard-app/src/lib/api.ts`
- Test: `apps/dashboard-app/tests/api.test.ts`

**Interfaces:**
- Produces: `createApiClient(config: { baseUrl: string; fetchImpl?: typeof fetch }): ApiClient` with `{ get, post, put, del, upload }` methods, `class ApiError extends Error { status: number }`, and a default singleton `export const api = createApiClient({ baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3000' })`. Every screen task (7 onward) imports `{ api, ApiError }` from this file.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard-app/tests/api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/lib/api.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createApiClient', () => {
  it('sends credentials and a JSON content-type on GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    const result = await client.get<{ ok: boolean }>('/v1/documents');
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/documents');
    expect(init.credentials).toBe('include');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('serializes the body on post and put', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await client.post('/v1/documents/text', { title: 'x', text: 'y' });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'x', text: 'y' });
  });

  it('throws an ApiError carrying the status and server message on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await expect(client.get('/v1/conversations/x')).rejects.toMatchObject(
      new ApiError(404, 'not found'),
    );
  });

  it('returns undefined for a 204 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    expect(await client.del('/v1/widget-keys/x')).toBeUndefined();
  });

  it('uploads FormData without setting a JSON content-type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }, 201));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    const form = new FormData();
    form.append('file', new Blob(['hi']), 'a.txt');
    await client.upload('/v1/documents', form);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

Create `apps/dashboard-app/src/lib/api.ts`:

```ts
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiClientConfig {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  upload<T>(path: string, form: FormData): Promise<T>;
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Every admin fetch: cookie-authenticated, JSON in/out unless uploading a file. */
export function createApiClient({ baseUrl, fetchImpl = fetch }: ApiClientConfig): ApiClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, credentials: 'include' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
    }
    return parseBody<T>(res);
  }

  return {
    get: (path) => request(path),
    post: (path, body) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    put: (path, body) => request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    del: (path) => request(path, { method: 'DELETE' }),
    upload: (path, form) => request(path, { method: 'POST', body: form }),
  };
}

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/lib/api.ts apps/dashboard-app/tests/api.test.ts
git commit -m "feat(dashboard): typed fetch client for the admin API"
```

---

## Task 7: dashboard-app — Better Auth client and sign-in screen

**Files:**
- Create: `apps/dashboard-app/src/lib/auth-client.ts`
- Create: `apps/dashboard-app/src/screens/SignIn.tsx`
- Test: `apps/dashboard-app/tests/sign-in.test.tsx`

**Interfaces:**
- Consumes: nothing new (only `import.meta.env.VITE_API_URL`).
- Produces: `authClient` (from `better-auth/react` + `organizationClient()`), re-exported hooks `useSession`, `useListOrganizations`, `useActiveOrganization` from `lib/auth-client.ts`; `<SignIn />` component rendered at `/sign-in`. Task 8 imports `authClient` and the hooks from this file.

- [ ] **Step 1: Write the auth client**

Create `apps/dashboard-app/src/lib/auth-client.ts`:

```ts
import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
  plugins: [organizationClient()],
});

export const { useSession, useListOrganizations, useActiveOrganization } = authClient;
```

- [ ] **Step 2: Write the failing sign-in test**

Create `apps/dashboard-app/tests/sign-in.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const signInEmail = vi.fn();
const navigateSpy = vi.fn();

vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: { signIn: { email: (...args: unknown[]) => signInEmail(...args) } },
}));
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const { SignIn } = await import('../src/screens/SignIn.tsx');

afterEach(() => {
  cleanup();
  signInEmail.mockReset();
  navigateSpy.mockReset();
});

describe('SignIn', () => {
  it('submits the entered email and password', async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null });
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(signInEmail).toHaveBeenCalledWith({
      email: 'admin@acme.test', password: 'hunter22',
    }));
  });

  it('navigates to the dashboard root on success', async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null });
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('shows the server error and does not navigate on failure', async () => {
    signInEmail.mockResolvedValue({ data: null, error: { message: 'Invalid email or password' } });
    render(<MemoryRouter><SignIn /></MemoryRouter>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@acme.test');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeInTheDocument());
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- sign-in.test.tsx`
Expected: FAIL — `../src/screens/SignIn.tsx` not found.

- [ ] **Step 4: Implement the sign-in screen**

Create `apps/dashboard-app/src/screens/SignIn.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '../lib/auth-client.ts';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (signInError) {
      setError(signInError.message ?? 'Sign-in failed');
      return;
    }
    navigate('/', { replace: true });
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50 font-sans text-sm">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-gray-900">Sign in to Groundwork</h1>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
        <div className="space-y-1">
          <label htmlFor="email" className="block font-medium text-gray-700">Email</label>
          <input
            id="email" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-gray-500"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="block font-medium text-gray-700">Password</label>
          <input
            id="password" type="password" required value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-gray-500"
          />
        </div>
        <button
          type="submit" disabled={busy}
          className="w-full rounded-lg bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- sign-in.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/lib/auth-client.ts apps/dashboard-app/src/screens/SignIn.tsx apps/dashboard-app/tests/sign-in.test.tsx
git commit -m "feat(dashboard): Better Auth client and sign-in screen"
```

---

## Task 8: dashboard-app — authenticated layout, org gate, and router wiring

**Files:**
- Create: `apps/dashboard-app/src/screens/AuthenticatedLayout.tsx`
- Modify: `apps/dashboard-app/src/App.tsx`
- Test: `apps/dashboard-app/tests/authenticated-layout.test.tsx`

**Interfaces:**
- Consumes: `authClient`, `useSession`, `useListOrganizations` from Task 7's `lib/auth-client.ts`.
- Produces: `<AuthenticatedLayout />`, wrapping an `<Outlet />`, handling redirect-to-sign-in, zero/one/many-org states, and the nav sidebar. `App.tsx` gets its real router tree; every screen task from 9 onward is registered as a child route here.

- [ ] **Step 1: Write the failing layout tests**

Create `apps/dashboard-app/tests/authenticated-layout.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const useSession = vi.fn();
const useListOrganizations = vi.fn();
const setActive = vi.fn();
const signOut = vi.fn();

vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: { organization: { setActive }, signOut },
  useSession: () => useSession(),
  useListOrganizations: () => useListOrganizations(),
}));

const { AuthenticatedLayout } = await import('../src/screens/AuthenticatedLayout.tsx');

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/documents']}>
      <Routes>
        <Route path="/sign-in" element={<div>Sign-in page</div>} />
        <Route element={<AuthenticatedLayout />}>
          <Route path="documents" element={<div>Documents screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useSession.mockReset();
  useListOrganizations.mockReset();
  setActive.mockReset();
  signOut.mockReset();
});

describe('AuthenticatedLayout', () => {
  it('redirects to sign-in when there is no session', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    useListOrganizations.mockReturnValue({ data: null, isPending: false });
    renderLayout();
    await waitFor(() => expect(screen.getByText('Sign-in page')).toBeInTheDocument());
  });

  it('shows a message when the user belongs to no organization', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({ data: [], isPending: false });
    renderLayout();
    await waitFor(() => expect(screen.getByText(/don't belong to an organization/i)).toBeInTheDocument());
  });

  it('auto-activates the org when the user belongs to exactly one', async () => {
    setActive.mockResolvedValue({});
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({
      data: [{ id: 'org-1', name: 'Acme' }], isPending: false,
    });
    renderLayout();
    await waitFor(() => expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-1' }));
  });

  it('shows a picker when the user belongs to more than one organization', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({
      data: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }], isPending: false,
    });
    renderLayout();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Globex' })).toBeInTheDocument();
    expect(setActive).not.toHaveBeenCalled();
  });

  it('calling setActive from the picker activates that org', async () => {
    setActive.mockResolvedValue({});
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false });
    useListOrganizations.mockReturnValue({
      data: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }], isPending: false,
    });
    renderLayout();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Globex' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Globex' }));
    expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-2' });
  });

  it('renders the nav and the active screen once an org is active', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: 'org-1' } }, isPending: false });
    useListOrganizations.mockReturnValue({ data: [{ id: 'org-1', name: 'Acme' }], isPending: false });
    renderLayout();
    await waitFor(() => expect(screen.getByText('Documents screen')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('signs out when the sign-out button is clicked', async () => {
    useSession.mockReturnValue({ data: { session: { activeOrganizationId: 'org-1' } }, isPending: false });
    useListOrganizations.mockReturnValue({ data: [{ id: 'org-1', name: 'Acme' }], isPending: false });
    renderLayout();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Documents screen')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @groundwork/dashboard-app -- authenticated-layout.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the layout**

Create `apps/dashboard-app/src/screens/AuthenticatedLayout.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { authClient, useListOrganizations, useSession } from '../lib/auth-client.ts';

const NAV_ITEMS = [
  { to: '/documents', label: 'Documents' },
  { to: '/conversations', label: 'Conversations' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/widget', label: 'Widget' },
  { to: '/widget-keys', label: 'Widget keys' },
];

export function AuthenticatedLayout() {
  const { data: session, isPending: sessionPending } = useSession();
  const { data: organizations, isPending: orgsPending } = useListOrganizations();
  const [autoActivating, setAutoActivating] = useState(false);

  const activeOrgId = session?.session.activeOrganizationId ?? null;

  useEffect(() => {
    if (!organizations || organizations.length !== 1 || activeOrgId) return;
    setAutoActivating(true);
    void authClient.organization
      .setActive({ organizationId: organizations[0]!.id })
      .finally(() => setAutoActivating(false));
  }, [organizations, activeOrgId]);

  if (sessionPending || orgsPending || autoActivating) {
    return <div className="flex h-screen items-center justify-center text-gray-500">Loading…</div>;
  }

  if (!session) return <Navigate to="/sign-in" replace />;

  if (!organizations || organizations.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center px-8 text-center text-gray-600">
        <p>You don&apos;t belong to an organization yet. Ask an admin to invite you.</p>
      </div>
    );
  }

  if (!activeOrgId) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 font-sans text-sm">
        <p className="text-gray-700">Choose an organization</p>
        {organizations.map((org) => (
          <button
            key={org.id}
            type="button"
            className="rounded-lg border border-gray-300 px-4 py-2 hover:bg-gray-50"
            onClick={() => void authClient.organization.setActive({ organizationId: org.id })}
          >
            {org.name}
          </button>
        ))}
      </div>
    );
  }

  const activeOrg = organizations.find((o) => o.id === activeOrgId);

  return (
    <div className="flex h-screen w-screen font-sans text-sm text-gray-900">
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white p-4">
        <div className="mb-6">
          <p className="text-xs uppercase text-gray-400">Organization</p>
          <p className="font-semibold">{activeOrg?.name ?? 'Unknown'}</p>
        </div>
        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                'block rounded-lg px-3 py-2 ' + (isActive ? 'bg-gray-900 text-white' : 'text-gray-700 hover:bg-gray-100')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => void authClient.signOut()}
          className="mt-4 rounded-lg border border-gray-300 px-3 py-2 text-left text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @groundwork/dashboard-app -- authenticated-layout.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the real router into App.tsx**

Replace the placeholder in `apps/dashboard-app/src/App.tsx`. Screens 9-12 don't exist yet, so this step imports them ahead of when they're written — that's expected; Task 9 onward each create the file the router already points at. Full file:

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthenticatedLayout } from './screens/AuthenticatedLayout.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { Documents } from './screens/Documents.tsx';
import { Conversations } from './screens/Conversations.tsx';
import { ConversationDetail } from './screens/ConversationDetail.tsx';
import { Analytics } from './screens/Analytics.tsx';
import { WidgetConfigurator } from './screens/WidgetConfigurator.tsx';
import { WidgetKeys } from './screens/WidgetKeys.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route element={<AuthenticatedLayout />}>
          <Route index element={<Navigate to="/documents" replace />} />
          <Route path="documents" element={<Documents />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<ConversationDetail />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="widget" element={<WidgetConfigurator />} />
          <Route path="widget-keys" element={<WidgetKeys />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

This will not typecheck until Tasks 9-12 create those five files — that's fine, they're the very next tasks. Do not run `typecheck` or `build` at the end of this task; Task 12's Step 5 is the next point the whole app compiles.

- [ ] **Step 6: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/screens/AuthenticatedLayout.tsx apps/dashboard-app/src/App.tsx apps/dashboard-app/tests/authenticated-layout.test.tsx
git commit -m "feat(dashboard): authenticated layout with org gate/switcher and router wiring"
```

---

## Task 9: dashboard-app — Documents screen

**Files:**
- Create: `apps/dashboard-app/src/screens/Documents.tsx`
- Test: `apps/dashboard-app/tests/documents.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from Task 6's `lib/api.ts`. Talks to the existing `GET/POST /v1/documents`, `POST /v1/documents/text`, `POST /v1/documents/:id/reembed`, `DELETE /v1/documents/:id` from `apps/api/src/modules/documents/routes.ts` (Task 2 of Phase 1 — already shipped, unmodified here).
- Produces: `<Documents />`, the first child route App.tsx (Task 8) already points at.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard-app/tests/documents.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const get = vi.fn();
const del = vi.fn();
const post = vi.fn();
const upload = vi.fn();

vi.mock('../src/lib/api.ts', () => ({
  api: { get, del, post, upload },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { Documents } = await import('../src/screens/Documents.tsx');

const ROW = {
  id: 'doc-1', title: 'Handbook.pdf', sourceType: 'pdf', status: 'ready',
  chunkCount: 12, tokenCount: 4000, pageCount: 8, byteSize: 20000,
  errorMessage: null, createdAt: '2026-08-01T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  get.mockReset(); del.mockReset(); post.mockReset(); upload.mockReset();
});

describe('Documents', () => {
  it('lists documents returned by the API', async () => {
    get.mockResolvedValue([ROW]);
    render(<Documents />);
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/documents');
  });

  it('shows an empty state with no documents', async () => {
    get.mockResolvedValue([]);
    render(<Documents />);
    await waitFor(() => expect(screen.getByText(/no documents yet/i)).toBeInTheDocument());
  });

  it('uploads a selected file and reloads the list', async () => {
    get.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    upload.mockResolvedValue({ id: 'doc-1', status: 'pending', duplicate: false });
    render(<Documents />);
    await waitFor(() => expect(screen.getByText(/no documents yet/i)).toBeInTheDocument());

    const file = new File(['content'], 'Handbook.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);

    await waitFor(() => expect(upload).toHaveBeenCalledWith('/v1/documents', expect.any(FormData)));
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());
  });

  it('deletes a document when Delete is clicked', async () => {
    get.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([]);
    del.mockResolvedValue(undefined);
    render(<Documents />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/documents/doc-1'));
  });

  it('triggers a re-embed when Re-embed is clicked', async () => {
    get.mockResolvedValue([ROW]);
    post.mockResolvedValue({ id: 'doc-1', status: 'pending' });
    render(<Documents />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /re-embed/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/documents/doc-1/reembed'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- documents.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the screen**

Create `apps/dashboard-app/src/screens/Documents.tsx`:

```tsx
import { useEffect, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';

interface DocumentRow {
  id: string;
  title: string;
  sourceType: string;
  status: string;
  chunkCount: number;
  tokenCount: number;
  pageCount: number | null;
  byteSize: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export function Documents() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setDocuments(await api.get<DocumentRow[]>('/v1/documents'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.upload('/v1/documents', form);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    await api.del(`/v1/documents/${id}`);
    await load();
  }

  async function handleReembed(id: string) {
    await api.post(`/v1/documents/${id}/reembed`);
    await load();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Documents</h1>
        <label className="cursor-pointer rounded-lg bg-gray-900 px-4 py-2 text-white">
          {uploading ? 'Uploading…' : 'Upload document'}
          <input
            type="file" accept=".pdf,.txt,.md" className="hidden"
            onChange={(e) => void handleUpload(e)} disabled={uploading}
          />
        </label>
      </div>
      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : documents.length === 0 ? (
        <p className="text-gray-500">No documents yet. Upload one to get started.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Title</th>
              <th className="py-2">Status</th>
              <th className="py-2">Chunks</th>
              <th className="py-2">Pages</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b border-gray-100">
                <td className="py-2">{doc.title}</td>
                <td className="py-2">
                  {doc.status}
                  {doc.errorMessage && <span className="ml-2 text-xs text-red-600">{doc.errorMessage}</span>}
                </td>
                <td className="py-2">{doc.chunkCount}</td>
                <td className="py-2">{doc.pageCount ?? '—'}</td>
                <td className="space-x-3 py-2 text-right">
                  <button type="button" className="text-gray-600 hover:underline" onClick={() => void handleReembed(doc.id)}>
                    Re-embed
                  </button>
                  <button type="button" className="text-red-600 hover:underline" onClick={() => void handleDelete(doc.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- documents.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/screens/Documents.tsx apps/dashboard-app/tests/documents.test.tsx
git commit -m "feat(dashboard): document library screen"
```

---

## Task 10: dashboard-app — Conversations list and detail screens

**Files:**
- Create: `apps/dashboard-app/src/screens/Conversations.tsx`
- Create: `apps/dashboard-app/src/screens/ConversationDetail.tsx`
- Test: `apps/dashboard-app/tests/conversations.test.tsx`
- Test: `apps/dashboard-app/tests/conversation-detail.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `lib/api.ts`; `GET /v1/conversations` and `GET /v1/conversations/:id` from Task 2.
- Produces: `<Conversations />` (list, each row links to `/conversations/:id`), `<ConversationDetail />` (reads `:id` via `useParams`).

- [ ] **Step 1: Write the failing list test**

Create `apps/dashboard-app/tests/conversations.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const get = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  api: { get },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { Conversations } = await import('../src/screens/Conversations.tsx');

afterEach(() => { cleanup(); get.mockReset(); });

describe('Conversations', () => {
  it('lists sessions with a visitor id, origin, and message count', async () => {
    get.mockResolvedValue([{
      id: 'sess-1', visitorId: 'v-123', origin: 'https://acme.test',
      startedAt: '2026-08-01T00:00:00.000Z', lastMessageAt: '2026-08-01T00:05:00.000Z',
      messageCount: 4,
    }]);
    render(<MemoryRouter><Conversations /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('v-123')).toBeInTheDocument());
    expect(screen.getByText('https://acme.test')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /v-123/ })).toHaveAttribute('href', '/conversations/sess-1');
  });

  it('shows an empty state with no conversations', async () => {
    get.mockResolvedValue([]);
    render(<MemoryRouter><Conversations /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the list test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- conversations.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the list screen**

Create `apps/dashboard-app/src/screens/Conversations.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';

interface ConversationRow {
  id: string;
  visitorId: string | null;
  origin: string | null;
  startedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
}

export function Conversations() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<ConversationRow[]>('/v1/conversations')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load conversations'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-500">Loading…</p>;
  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Conversations</h1>
      {rows.length === 0 ? (
        <p className="text-gray-500">No conversations yet.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Visitor</th>
              <th className="py-2">Origin</th>
              <th className="py-2">Last message</th>
              <th className="py-2">Messages</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-gray-100">
                <td className="py-2">
                  <Link to={`/conversations/${row.id}`} className="text-gray-900 underline decoration-dotted hover:text-gray-600">
                    {row.visitorId ?? row.id}
                  </Link>
                </td>
                <td className="py-2">{row.origin ?? '—'}</td>
                <td className="py-2">{row.lastMessageAt ? new Date(row.lastMessageAt).toLocaleString() : '—'}</td>
                <td className="py-2">{row.messageCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the list test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- conversations.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing detail test**

Create `apps/dashboard-app/tests/conversation-detail.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const get = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  api: { get },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Imported after vi.mock so this resolves to the mocked class above — the
// component's `err instanceof ApiError` check must see the same constructor
// the test throws, or the error branch silently falls through to the generic
// fallback message and the assertion below would pass for the wrong reason.
const { ApiError } = await import('../src/lib/api.ts');
const { ConversationDetail } = await import('../src/screens/ConversationDetail.tsx');

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/conversations/${id}`]}>
      <Routes>
        <Route path="/conversations/:id" element={<ConversationDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); get.mockReset(); });

describe('ConversationDetail', () => {
  it('renders the transcript with roles, content, and citations', async () => {
    get.mockResolvedValue({
      id: 'sess-1',
      messages: [
        { id: 'm1', role: 'user', content: 'How long do refunds take?', answered: null, topScore: null, createdAt: '2026-08-01T00:00:00.000Z', citations: [] },
        {
          id: 'm2', role: 'assistant', content: 'Refunds take 14 days.', answered: true, topScore: 0.81,
          createdAt: '2026-08-01T00:00:05.000Z',
          citations: [{ n: 1, documentTitle: 'Handbook', headingPath: 'Refunds', pageFrom: 2, pageTo: 2, excerpt: 'Refunds are issued within 14 days.' }],
        },
      ],
    });
    renderAt('sess-1');
    await waitFor(() => expect(screen.getByText('How long do refunds take?')).toBeInTheDocument());
    expect(screen.getByText('Refunds take 14 days.')).toBeInTheDocument();
    expect(screen.getByText(/Handbook/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/conversations/sess-1');
  });

  it('shows a not-found message for a missing conversation', async () => {
    get.mockRejectedValue(new ApiError(404, 'conversation not found'));
    renderAt('missing');
    await waitFor(() => expect(screen.getByText(/conversation not found/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 6: Run the detail test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- conversation-detail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the detail screen**

Create `apps/dashboard-app/src/screens/ConversationDetail.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';

interface TranscriptCitation {
  n: number;
  documentTitle: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
}

interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  answered: boolean | null;
  topScore: number | null;
  createdAt: string;
  citations: TranscriptCitation[];
}

export function ConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get<{ id: string; messages: TranscriptMessage[] }>(`/v1/conversations/${id}`)
      .then((res) => setMessages(res.messages))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load conversation'));
  }, [id]);

  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;
  if (!messages) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">Conversation</h1>
      {messages.map((m) => (
        <div key={m.id} className={m.role === 'user' ? 'text-right' : 'text-left'}>
          <div
            className={
              'inline-block max-w-[85%] rounded-2xl px-3 py-2 ' +
              (m.role === 'user' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900')
            }
          >
            {m.content}
          </div>
          {m.citations.length > 0 && (
            <ul className="mt-1 space-y-1 text-left text-xs text-gray-500">
              {m.citations.map((c) => (
                <li key={c.n}>
                  [{c.n}] {c.documentTitle}
                  {c.headingPath ? ` — ${c.headingPath}` : ''}
                  {c.pageFrom ? ` (p. ${c.pageFrom})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Run the detail test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- conversation-detail.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/screens/Conversations.tsx apps/dashboard-app/src/screens/ConversationDetail.tsx apps/dashboard-app/tests/conversations.test.tsx apps/dashboard-app/tests/conversation-detail.test.tsx
git commit -m "feat(dashboard): conversation list and transcript detail screens"
```

---

## Task 11: dashboard-app — Analytics screen (charts + unanswered questions)

**Files:**
- Create: `apps/dashboard-app/src/screens/Analytics.tsx`
- Create: `apps/dashboard-app/src/components/DailyBarChart.tsx`
- Test: `apps/dashboard-app/tests/daily-bar-chart.test.tsx`
- Test: `apps/dashboard-app/tests/analytics.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `lib/api.ts`; `GET /v1/analytics/overview`, `GET /v1/analytics/unanswered` from Task 3.
- Produces: `<DailyBarChart data={{ date: string; value: number }[]} />` (hand-rolled SVG bar chart), `<Analytics />` screen using it twice (messages/day, cost/day) plus the unanswered-questions table.

- [ ] **Step 1: Invoke the dataviz skill**

Before writing any chart code, load the `dataviz` skill for its color/mark/accessibility guidance, then use it to inform Steps 2-3 below (categorical color choice, axis/legend conventions, light+dark support).

- [ ] **Step 2: Write the failing chart component test**

Create `apps/dashboard-app/tests/daily-bar-chart.test.tsx`:

```ts
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DailyBarChart } from '../src/components/DailyBarChart.tsx';

describe('DailyBarChart', () => {
  it('renders one bar per data point', () => {
    render(<DailyBarChart data={[
      { date: '2026-08-01', value: 3 },
      { date: '2026-08-02', value: 7 },
    ]} />);
    // Each bar carries its value as an accessible label for screen readers.
    expect(screen.getAllByRole('img', { hidden: true })).toHaveLength(2);
    expect(screen.getByLabelText('2026-08-01: 3')).toBeInTheDocument();
    expect(screen.getByLabelText('2026-08-02: 7')).toBeInTheDocument();
  });

  it('renders an empty-state message with no data points', () => {
    render(<DailyBarChart data={[]} />);
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- daily-bar-chart.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the chart component**

Create `apps/dashboard-app/src/components/DailyBarChart.tsx`. Follow whatever the dataviz skill's palette/spacing guidance from Step 1 recommends; the structure below is the functional contract the test checks against — adapt colors/sizing to match the skill, not this literal snippet, if they differ:

```tsx
export interface DailyBarChartPoint {
  date: string;
  value: number;
}

export interface DailyBarChartProps {
  data: DailyBarChartPoint[];
  formatValue?: (value: number) => string;
}

const HEIGHT = 120;
const BAR_GAP = 4;

export function DailyBarChart({ data, formatValue = String }: DailyBarChartProps) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-400">No data for this period.</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = Math.max(100 / data.length - BAR_GAP / 4, 1);

  return (
    <svg
      viewBox={`0 0 100 ${HEIGHT}`}
      preserveAspectRatio="none"
      className="h-32 w-full"
      role="group"
      aria-label="Daily values"
    >
      {data.map((point, i) => {
        const barHeight = (point.value / max) * (HEIGHT - 16);
        const x = i * (100 / data.length);
        return (
          <rect
            key={point.date}
            x={x}
            y={HEIGHT - barHeight}
            width={barWidth}
            height={barHeight}
            className="fill-gray-700"
            role="img"
            aria-label={`${point.date}: ${formatValue(point.value)}`}
          >
            <title>{`${point.date}: ${formatValue(point.value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- daily-bar-chart.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing Analytics screen test**

Create `apps/dashboard-app/tests/analytics.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const get = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  api: { get },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { Analytics } = await import('../src/screens/Analytics.tsx');

afterEach(() => { cleanup(); get.mockReset(); });

describe('Analytics', () => {
  it('shows total messages, answer rate, and total cost', async () => {
    get.mockImplementation((path: string) => {
      if (path.includes('/overview')) {
        return Promise.resolve({
          messagesByDay: [{ date: '2026-08-01', count: 3 }],
          costByDay: [{ date: '2026-08-01', costUsd: 0.0012 }],
          answerRate: 0.75,
          totalMessages: 4,
          totalCostUsd: 0.0012,
        });
      }
      return Promise.resolve([{ content: 'Do you ship to Canada?', frequency: 2 }]);
    });
    render(<Analytics />);
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('$0.0012')).toBeInTheDocument();
  });

  it('lists top unanswered questions with their frequency', async () => {
    get.mockImplementation((path: string) => {
      if (path.includes('/overview')) {
        return Promise.resolve({
          messagesByDay: [], costByDay: [], answerRate: 1, totalMessages: 0, totalCostUsd: 0,
        });
      }
      return Promise.resolve([{ content: 'Do you ship to Canada?', frequency: 5 }]);
    });
    render(<Analytics />);
    await waitFor(() => expect(screen.getByText('Do you ship to Canada?')).toBeInTheDocument());
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- analytics.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the Analytics screen**

Create `apps/dashboard-app/src/screens/Analytics.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { DailyBarChart } from '../components/DailyBarChart.tsx';

interface AnalyticsOverview {
  messagesByDay: { date: string; count: number }[];
  costByDay: { date: string; costUsd: number }[];
  answerRate: number;
  totalMessages: number;
  totalCostUsd: number;
}

interface UnansweredQuestion {
  content: string;
  frequency: number;
}

export function Analytics() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [unanswered, setUnanswered] = useState<UnansweredQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<AnalyticsOverview>('/v1/analytics/overview?days=30'),
      api.get<UnansweredQuestion[]>('/v1/analytics/unanswered?days=30&limit=20'),
    ])
      .then(([o, u]) => {
        setOverview(o);
        setUnanswered(u);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load analytics'));
  }, []);

  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;
  if (!overview) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-lg font-semibold">Analytics — last 30 days</h1>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs uppercase text-gray-400">Messages</p>
          <p className="text-2xl font-semibold">{overview.totalMessages}</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs uppercase text-gray-400">Answer rate</p>
          <p className="text-2xl font-semibold">{Math.round(overview.answerRate * 100)}%</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs uppercase text-gray-400">Spend</p>
          <p className="text-2xl font-semibold">${overview.totalCostUsd.toFixed(4)}</p>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Messages per day</h2>
        <DailyBarChart data={overview.messagesByDay.map((d) => ({ date: d.date, value: d.count }))} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Spend per day</h2>
        <DailyBarChart
          data={overview.costByDay.map((d) => ({ date: d.date, value: d.costUsd }))}
          formatValue={(v) => `$${v.toFixed(4)}`}
        />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Top unanswered questions</h2>
        {unanswered.length === 0 ? (
          <p className="text-gray-500">No unanswered questions in this period.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2">Question</th>
                <th className="py-2">Asked</th>
              </tr>
            </thead>
            <tbody>
              {unanswered.map((q) => (
                <tr key={q.content} className="border-b border-gray-100">
                  <td className="py-2">{q.content}</td>
                  <td className="py-2">{q.frequency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- analytics.test.tsx`
Expected: PASS.

- [ ] **Step 10: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/screens/Analytics.tsx apps/dashboard-app/src/components/DailyBarChart.tsx apps/dashboard-app/tests/daily-bar-chart.test.tsx apps/dashboard-app/tests/analytics.test.tsx
git commit -m "feat(dashboard): analytics screen with hand-rolled charts and unanswered questions"
```

---

## Task 12: dashboard-app — Widget configurator with live preview

**Files:**
- Create: `apps/dashboard-app/src/screens/WidgetConfigurator.tsx`
- Test: `apps/dashboard-app/tests/widget-configurator.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `lib/api.ts`; `GET/PUT /v1/org-settings` from Task 4; `GET/POST /v1/widget-keys` from the pre-existing `modules/widget-keys/routes.ts` (used here only to find-or-create a key for the preview iframe — full key management UI is Task 13).
- Produces: `<WidgetConfigurator />`, the sixth screen App.tsx already routes to. This is the last screen task, so it also completes App.tsx's compile-ability (Step 6 below runs the full build for the first time since Task 8).

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard-app/tests/widget-configurator.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();

vi.mock('../src/lib/api.ts', () => ({
  api: { get, put, post },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { WidgetConfigurator } = await import('../src/screens/WidgetConfigurator.tsx');

const SETTINGS = {
  welcomeMessage: 'Hi! Ask me anything.', suggestedQuestions: [], systemPrompt: null,
  noAnswerMessage: "I couldn't find an answer to that.", minScore: 0.65, topK: 6,
};

afterEach(() => { cleanup(); get.mockReset(); put.mockReset(); post.mockReset(); vi.useRealTimers(); });

describe('WidgetConfigurator', () => {
  it('loads current settings into the form and shows a live-preview iframe', async () => {
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([{ id: 'k1', publicKey: 'pk_live_x' }]));
    render(<WidgetConfigurator />);
    await waitFor(() => expect(screen.getByDisplayValue('Hi! Ask me anything.')).toBeInTheDocument());
    expect(screen.getByTitle(/widget preview/i)).toBeInTheDocument();
  });

  it('creates a widget key for preview when the org has none yet', async () => {
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([]));
    post.mockResolvedValue({ id: 'k1', publicKey: 'pk_live_new' });
    render(<WidgetConfigurator />);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/widget-keys', expect.objectContaining({
      name: 'Dashboard preview',
    })));
  });

  it('saves an edited welcome message after the debounce delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([{ id: 'k1', publicKey: 'pk_live_x' }]));
    put.mockResolvedValue({ ...SETTINGS, welcomeMessage: 'New greeting' });
    render(<WidgetConfigurator />);
    await waitFor(() => expect(screen.getByDisplayValue('Hi! Ask me anything.')).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    const input = screen.getByLabelText(/welcome message/i);
    await user.clear(input);
    await user.type(input, 'New greeting');

    await act(async () => { vi.advanceTimersByTime(700); });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/org-settings', expect.objectContaining({
      welcomeMessage: 'New greeting',
    })));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- widget-configurator.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the screen**

Create `apps/dashboard-app/src/screens/WidgetConfigurator.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';

interface OrgSettings {
  welcomeMessage: string;
  suggestedQuestions: string[];
  systemPrompt: string | null;
  noAnswerMessage: string;
  minScore: number;
  topK: number;
}

interface WidgetKey {
  id: string;
  publicKey: string;
}

const DEBOUNCE_MS = 600;
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export function WidgetConfigurator() {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.get<OrgSettings>('/v1/org-settings')
      .then(setSettings)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load settings'));

    api.get<WidgetKey[]>('/v1/widget-keys').then(async (keys) => {
      if (keys.length > 0) {
        setPreviewKey(keys[0]!.publicKey);
        return;
      }
      const created = await api.post<WidgetKey>('/v1/widget-keys', {
        name: 'Dashboard preview', allowedOrigins: [window.location.origin],
      });
      setPreviewKey(created.publicKey);
    }).catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load widget key'));
  }, []);

  function scheduleSave(next: OrgSettings) {
    setSettings(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.put<OrgSettings>('/v1/org-settings', next)
        .then(() => setPreviewNonce((n) => n + 1))
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to save'));
    }, DEBOUNCE_MS);
  }

  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;
  if (!settings) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="flex gap-8">
      <form className="w-96 space-y-4" onSubmit={(e) => e.preventDefault()}>
        <h1 className="text-lg font-semibold">Widget configuration</h1>
        <div className="space-y-1">
          <label htmlFor="welcomeMessage" className="block text-sm font-medium text-gray-700">Welcome message</label>
          <textarea
            id="welcomeMessage" rows={2} value={settings.welcomeMessage}
            onChange={(e) => scheduleSave({ ...settings, welcomeMessage: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="noAnswerMessage" className="block text-sm font-medium text-gray-700">No-answer message</label>
          <textarea
            id="noAnswerMessage" rows={2} value={settings.noAnswerMessage}
            onChange={(e) => scheduleSave({ ...settings, noAnswerMessage: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="minScore" className="block text-sm font-medium text-gray-700">
            Relevance threshold ({settings.minScore.toFixed(2)})
          </label>
          <input
            id="minScore" type="range" min={0} max={1} step={0.01} value={settings.minScore}
            onChange={(e) => scheduleSave({ ...settings, minScore: Number(e.target.value) })}
            className="w-full"
          />
        </div>
      </form>
      <div className="flex-1">
        <h2 className="mb-2 text-sm font-medium text-gray-700">Live preview</h2>
        {previewKey ? (
          <iframe
            key={previewNonce}
            title="Widget preview"
            src={`${API_URL}/../widget?api=${encodeURIComponent(API_URL)}&key=${encodeURIComponent(previewKey)}`}
            className="h-[600px] w-96 rounded-lg border border-gray-200"
          />
        ) : (
          <p className="text-gray-500">Preparing preview…</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- widget-configurator.test.tsx`
Expected: PASS.

- [ ] **Step 5: Fix the preview iframe's URL — Step 3's `src` was a placeholder**

The `src` in Step 3 points at a `/widget` path relative to the API URL, which does not exist — `apps/widget-app`'s dev server and built assets are not wired into the API's static hosting anywhere in this repo today, and building that pipeline (or pointing at a deployed URL) is a deployment concern that belongs in Phase 6 (`apps/widget-app` gets its own Vercel target there, per ROADMAP.md). Point the preview at `apps/widget-app`'s own dev server instead, via a new env var:

```tsx
const WIDGET_APP_URL = import.meta.env.VITE_WIDGET_APP_URL ?? 'http://localhost:5173';
```

Add this constant next to `API_URL` in `WidgetConfigurator.tsx`, and change the iframe `src` to:

```tsx
            src={`${WIDGET_APP_URL}?api=${encodeURIComponent(API_URL)}&key=${encodeURIComponent(previewKey)}`}
```

Add to `apps/dashboard-app/.env.example` (after `VITE_API_URL`):

```
# apps/widget-app's dev server, used for the live preview in the widget
# configurator screen.
VITE_WIDGET_APP_URL="http://localhost:5173"
```

Re-run: `npm run test -w @groundwork/dashboard-app -- widget-configurator.test.tsx`
Expected: still PASS (the test doesn't assert on the exact `src`, only that the iframe exists).

- [ ] **Step 6: Full dashboard-app build and typecheck**

All six screens App.tsx imports now exist. Run:

Run: `npm run typecheck -w @groundwork/dashboard-app`
Run: `npm run test -w @groundwork/dashboard-app`
Run: `npm run build -w @groundwork/dashboard-app`
Expected: all clean. Task 13 adds the seventh screen (`WidgetKeys`), which App.tsx already imports — until Task 13 lands, this build step will fail on that missing file; if so, that's expected and Task 13 resolves it. If it fails for any *other* reason, stop and fix before proceeding.

- [ ] **Step 7: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/screens/WidgetConfigurator.tsx apps/dashboard-app/tests/widget-configurator.test.tsx apps/dashboard-app/.env.example
git commit -m "feat(dashboard): widget configurator with debounced save and live preview"
```

---

## Task 13: dashboard-app — Widget keys screen

**Files:**
- Create: `apps/dashboard-app/src/screens/WidgetKeys.tsx`
- Test: `apps/dashboard-app/tests/widget-keys.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` from `lib/api.ts`; `GET/POST/DELETE /v1/widget-keys` from the pre-existing `modules/widget-keys/routes.ts`.
- Produces: `<WidgetKeys />`, the last screen App.tsx routes to — this task makes the dashboard app fully buildable end to end.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard-app/tests/widget-keys.test.tsx`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('../src/lib/api.ts', () => ({
  api: { get, post, del },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { WidgetKeys } = await import('../src/screens/WidgetKeys.tsx');

const KEY = {
  id: 'k1', publicKey: 'pk_live_abc', name: 'Marketing site',
  allowedOrigins: ['https://acme.test'], rateLimitRpm: 20, monthlyMsgCap: 1000,
  revokedAt: null, createdAt: '2026-08-01T00:00:00.000Z',
};

afterEach(() => { cleanup(); get.mockReset(); post.mockReset(); del.mockReset(); });

describe('WidgetKeys', () => {
  it('lists existing keys with their allowed origins', async () => {
    get.mockResolvedValue([KEY]);
    render(<WidgetKeys />);
    await waitFor(() => expect(screen.getByText('pk_live_abc')).toBeInTheDocument());
    expect(screen.getByText('https://acme.test')).toBeInTheDocument();
  });

  it('creates a new key from the form', async () => {
    get.mockResolvedValueOnce([]).mockResolvedValueOnce([KEY]);
    post.mockResolvedValue(KEY);
    render(<WidgetKeys />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/name/i), 'Marketing site');
    await user.type(screen.getByLabelText(/allowed origins/i), 'https://acme.test');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/widget-keys', {
      name: 'Marketing site', allowedOrigins: ['https://acme.test'],
    }));
  });

  it('revokes a key when Revoke is clicked', async () => {
    get.mockResolvedValueOnce([KEY]).mockResolvedValueOnce([]);
    del.mockResolvedValue(undefined);
    render(<WidgetKeys />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('pk_live_abc')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/widget-keys/k1'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @groundwork/dashboard-app -- widget-keys.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the screen**

Create `apps/dashboard-app/src/screens/WidgetKeys.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';

interface WidgetKeyRow {
  id: string;
  publicKey: string;
  name: string | null;
  allowedOrigins: string[];
  rateLimitRpm: number;
  monthlyMsgCap: number;
  revokedAt: string | null;
  createdAt: string;
}

export function WidgetKeys() {
  const [keys, setKeys] = useState<WidgetKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');

  async function load() {
    setLoading(true);
    try {
      setKeys(await api.get<WidgetKeyRow[]>('/v1/widget-keys'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load widget keys');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const allowedOrigins = origins.split(',').map((o) => o.trim()).filter(Boolean);
    try {
      await api.post('/v1/widget-keys', { name: name || undefined, allowedOrigins });
      setName('');
      setOrigins('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create widget key');
    }
  }

  async function handleRevoke(id: string) {
    await api.del(`/v1/widget-keys/${id}`);
    await load();
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-lg font-semibold">Widget keys</h1>

      <form onSubmit={(e) => void handleCreate(e)} className="mb-6 flex items-end gap-3">
        <div className="flex-1 space-y-1">
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name</label>
          <input
            id="name" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex-1 space-y-1">
          <label htmlFor="origins" className="block text-sm font-medium text-gray-700">Allowed origins</label>
          <input
            id="origins" value={origins} onChange={(e) => setOrigins(e.target.value)}
            placeholder="https://example.com, https://www.example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button type="submit" className="rounded-lg bg-gray-900 px-4 py-2 text-white">Create</button>
      </form>

      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-gray-500">No widget keys yet.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Key</th>
              <th className="py-2">Name</th>
              <th className="py-2">Allowed origins</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b border-gray-100">
                <td className="py-2 font-mono text-xs">{key.publicKey}</td>
                <td className="py-2">{key.name ?? '—'}</td>
                <td className="py-2">{key.allowedOrigins.join(', ')}</td>
                <td className="py-2 text-right">
                  <button type="button" className="text-red-600 hover:underline" onClick={() => void handleRevoke(key.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @groundwork/dashboard-app -- widget-keys.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full dashboard-app verification**

Every screen App.tsx imports now exists. Run:

Run: `npm run typecheck -w @groundwork/dashboard-app`
Run: `npm run test -w @groundwork/dashboard-app`
Run: `npm run build -w @groundwork/dashboard-app`
Expected: all clean.

- [ ] **Step 6: Commit**

Print for Barinder to run:

```bash
git add apps/dashboard-app/src/screens/WidgetKeys.tsx apps/dashboard-app/tests/widget-keys.test.tsx
git commit -m "feat(dashboard): widget key management screen"
```

---

## Task 14: Whole-repo verification and phase-gate documentation

**Files:**
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`
- Create: `docs/phases/phase-4-admin-dashboard.md`

**Interfaces:** None — this task is verification and documentation only.

- [ ] **Step 1: Run the full monorepo test suite and typecheck**

Run: `npm run test` (from repo root — runs every workspace via Turborepo)
Run: `npm run typecheck`
Run: `npm run build`
Expected: everything passes. If anything fails, fix it before continuing — this is the gate the roadmap's exit criteria depends on.

- [ ] **Step 2: Manually verify the demo loop**

Start Postgres, then in three terminals: `npm run dev -w @groundwork/api`, `npm run dev -w @groundwork/widget-app`, `npm run dev -w @groundwork/dashboard-app`. Sign in to the dashboard with a seeded user (create one via `POST /api/auth/sign-up/email` and `POST /api/auth/organization/create` against a demo org from `npm run seed -w @groundwork/api` if none exists yet), upload a document, open the widget-app dev URL directly (`http://localhost:5173?api=http://localhost:3000&key=<a widget key's publicKey>`), ask it a question, then confirm the conversation, its cost, and the answer-rate figure all appear correctly in the dashboard. This is ROADMAP.md's Phase 4 exit criteria — do not tick the roadmap boxes until this passes for real, not just in tests.

- [ ] **Step 3: Update ROADMAP.md**

In `ROADMAP.md`:

Change the banner:
```
**Current phase:** Phase 5 — Hardening + Evals
**Status:** ⬜ Not started
**Last updated:** <today's date>
```

Change the summary table row:
```
| 4 | Admin dashboard | ✅ Done — <today's date> |
```

Change the Phase 4 section heading and checklist:
```
## ✅ Phase 4 — Admin Dashboard   `done <today's date>`

- [x] Document library — status, size, chunk count, re-embed, delete
- [x] Conversation browser with full transcripts and the citations each answer used
- [x] Analytics — messages over time, answer rate, spend by day
- [x] **Top unanswered questions**, mined from low-`top_score` messages
- [x] Widget configurator with live preview
- [x] Widget key management — create, revoke, set allowed origins and caps
```

Below the checklist, replace the Demo/Exit criteria lines with:
```
**Demo:** the full loop — upload a document, chat from the widget, watch the conversation and
its cost appear in the dashboard.
**Exit criteria:** dashboard message count, answer rate, and cost figures match the
`usage_events` rows for the same window. ✅
**Verified:** <fill in with the actual figures observed in Step 2 — e.g. "N messages, X% answer
rate, $Y spend in the dashboard matched N usage_events rows and their summed cost_usd exactly">.
**Deferred to Phase 6:** self-serve sign-up and org creation UI (dashboard ships sign-in only;
see docs/superpowers/specs/2026-08-20-phase-4-admin-dashboard-design.md).
**Cut:** widget theming (the `theme` column on `org_settings`) and its dashboard editor — nothing
in the widget renders it yet, so an editor would configure a setting with no effect.
```

Add a `Phase 5` note carrying forward the semantic-clustering deferral already listed in the design spec, so it isn't dropped: under Phase 5's checklist in `ROADMAP.md`, add a line:
```
- [ ] Semantic clustering of similar "unanswered" questions (Phase 4 shipped exact-text
      grouping only — revisit once the eval set exists)
```

- [ ] **Step 4: Add a CHANGELOG.md entry**

Read `CHANGELOG.md`'s existing format first, then add an entry in the same style covering: admin dashboard shipped (documents, conversations, analytics, widget configurator with live preview, widget key management), sign-in flow, and the three new API endpoint groups.

- [ ] **Step 5: Write phase closing notes**

Create `docs/phases/phase-4-admin-dashboard.md`, following the structure of `docs/phases/phase-3-widget.md` (read it first for the expected shape): what shipped, the two scope cuts (auth UI depth, widget theming) and why, the live-preview design decision (save-then-remount vs. postMessage draft sync) and why, and the actual verification evidence from Step 2 above (real figures, not placeholders).

- [ ] **Step 6: Commit**

Print for Barinder to run:

```bash
git add ROADMAP.md CHANGELOG.md docs/phases/phase-4-admin-dashboard.md
git commit -m "docs: close out Phase 4 — admin dashboard"
```
