import { parseConfig } from './config.ts';
import { mountWidget } from './widget.ts';

/** Exported separately so it is testable without depending on document.currentScript. */
export function initFromScript(script: HTMLScriptElement | null): void {
  const config = parseConfig(script);
  if (!config) return;
  mountWidget(config, document);
}

// `document.currentScript` is only reliable while a classic <script> is being
// parsed and executed synchronously — which is exactly the embed snippet's
// case, so no DOMContentLoaded wait is needed.
initFromScript(document.currentScript as HTMLScriptElement | null);
