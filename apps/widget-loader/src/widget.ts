import type { WidgetConfig } from './config.ts';

export interface WidgetHandle {
  host: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
}

const LAUNCHER_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

/**
 * Mounts the launcher button and (lazily) the chat iframe onto the host page.
 *
 * Everything lives inside a shadow root attached to a single host element, so
 * the launcher's own styling cannot leak into the client's page and the
 * client's CSS cannot reach in and override it — the same isolation guarantee
 * the iframe gives the chat UI itself, applied to the one piece of DOM that
 * necessarily lives outside that iframe.
 */
export function mountWidget(config: WidgetConfig, doc: Document): WidgetHandle {
  const host = doc.createElement('div');
  host.setAttribute('data-groundwork-widget', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = doc.createElement('style');
  style.textContent = `
    button {
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
      width: 56px; height: 56px; border-radius: 999px; border: none;
      background: #111827; color: white; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    }
    iframe {
      position: fixed; bottom: 88px; right: 20px; z-index: 2147483000;
      width: 380px; height: 600px; max-width: calc(100vw - 40px);
      max-height: calc(100vh - 120px); border: none; border-radius: 16px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.3);
    }
  `;
  shadow.appendChild(style);

  const button = doc.createElement('button');
  button.innerHTML = LAUNCHER_SVG;
  button.setAttribute('aria-label', 'Open support chat');
  shadow.appendChild(button);

  let iframe: HTMLIFrameElement | null = null;
  let isOpen = false;

  function ensureIframe(): HTMLIFrameElement {
    if (iframe) return iframe;
    const src = new URL(config.widgetUrl);
    src.searchParams.set('key', config.publicKey);
    src.searchParams.set('api', config.apiUrl);
    iframe = doc.createElement('iframe');
    iframe.src = src.toString();
    iframe.title = 'Support chat';
    shadow.appendChild(iframe);
    return iframe;
  }

  function open() {
    ensureIframe().style.display = 'block';
    isOpen = true;
  }
  function close() {
    if (iframe) iframe.style.display = 'none';
    isOpen = false;
  }

  button.addEventListener('click', () => (isOpen ? close() : open()));

  doc.body.appendChild(host);
  return { host, open, close, toggle: () => (isOpen ? close() : open()) };
}
