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
