export interface WidgetConfig {
  welcomeMessage: string;
  suggestedQuestions: string[];
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  welcomeMessage: 'Hi! Ask me anything.',
  suggestedQuestions: [],
};

export interface FetchWidgetConfigInput {
  apiUrl: string;
  publicKey: string;
  parentOrigin?: string;
  fetchImpl: typeof fetch;
}

/**
 * Greeting and suggested-question chips shown before any message is sent.
 *
 * Never throws and never blocks the chat from opening: a failure here (bad
 * key, network hiccup, server briefly down) falls back to a generic default
 * rather than surfacing an error for what is a cosmetic, non-essential call.
 */
export async function fetchWidgetConfig(input: FetchWidgetConfigInput): Promise<WidgetConfig> {
  const { apiUrl, publicKey, parentOrigin, fetchImpl } = input;
  try {
    const res = await fetchImpl(`${apiUrl}/v1/widget/config`, {
      method: 'GET',
      headers: {
        'x-widget-key': publicKey,
        ...(parentOrigin ? { 'x-widget-origin': parentOrigin } : {}),
      },
    });
    if (!res.ok) return DEFAULT_WIDGET_CONFIG;
    const body = await res.json();
    return { welcomeMessage: body.welcomeMessage, suggestedQuestions: body.suggestedQuestions };
  } catch {
    return DEFAULT_WIDGET_CONFIG;
  }
}
