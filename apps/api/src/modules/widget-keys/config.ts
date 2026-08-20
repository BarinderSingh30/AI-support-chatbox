import { eq } from 'drizzle-orm';
import { withTenant } from '../../db/with-tenant.ts';
import { orgSettings } from '../../db/schema/index.ts';

const DEFAULT_WELCOME_MESSAGE = 'Hi! Ask me anything.';

export interface WidgetConfig {
  welcomeMessage: string;
  suggestedQuestions: string[];
}

/**
 * Greeting and suggested-question chips shown when the widget opens with no
 * messages yet. A brand-new org has no org_settings row at all (it is created
 * lazily on first configuration), so this always returns something sensible
 * rather than requiring the row to exist.
 */
export async function getWidgetConfig(orgId: string): Promise<WidgetConfig> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
    return {
      welcomeMessage: row?.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE,
      suggestedQuestions: row?.suggestedQuestions ?? [],
    };
  });
}
