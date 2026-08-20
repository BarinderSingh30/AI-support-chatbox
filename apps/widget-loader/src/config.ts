export interface WidgetConfig {
  publicKey: string;
  apiUrl: string;
  widgetUrl: string;
}

/**
 * Baked in at build time via Vite's standard `VITE_`-prefixed env vars, so the
 * production bundle's embed snippet only needs `data-key` — matching the
 * "four lines of HTML" promise. Empty in dev builds, where the snippet
 * supplies data-api / data-widget-url explicitly instead.
 */
const DEFAULT_API_URL: string = import.meta.env.VITE_DEFAULT_API_URL ?? '';
const DEFAULT_WIDGET_URL: string = import.meta.env.VITE_DEFAULT_WIDGET_URL ?? '';

export function parseConfig(script: HTMLScriptElement | null): WidgetConfig | null {
  if (!script) {
    console.error('[groundwork] could not locate the widget <script> tag');
    return null;
  }

  const publicKey = script.getAttribute('data-key');
  if (!publicKey) {
    console.error('[groundwork] missing required attribute: data-key');
    return null;
  }

  const apiUrl = script.getAttribute('data-api') || DEFAULT_API_URL;
  if (!apiUrl) {
    console.error('[groundwork] missing required attribute: data-api');
    return null;
  }

  const widgetUrl = script.getAttribute('data-widget-url') || DEFAULT_WIDGET_URL || apiUrl;

  return { publicKey, apiUrl, widgetUrl };
}
