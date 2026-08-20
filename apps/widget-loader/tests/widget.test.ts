import { beforeEach, describe, expect, it } from 'vitest';
import { mountWidget } from '../src/widget.ts';

const config = { publicKey: 'pk_live_abc', apiUrl: 'https://api.acme.test', widgetUrl: 'https://widget.acme.test' };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('mountWidget', () => {
  it('adds exactly one element to the host page', () => {
    mountWidget(config, document);
    expect(document.body.children).toHaveLength(1);
  });

  it('isolates its styles in a shadow root so the host page cannot override them', () => {
    // This is the whole point of the launcher living outside the iframe: its
    // own CSS must not leak in from, or leak out to, the client's site.
    const handle = mountWidget(config, document);
    expect(handle.host.shadowRoot).not.toBeNull();
  });

  it('does not create the iframe until the launcher is opened', () => {
    // The client's site should not pay for loading the chat UI until a
    // visitor actually wants it.
    const handle = mountWidget(config, document);
    expect(handle.host.shadowRoot!.querySelector('iframe')).toBeNull();
  });

  it('creates the iframe with the key and api baked into its src on first open', () => {
    const handle = mountWidget(config, document);
    handle.open();
    const iframe = handle.host.shadowRoot!.querySelector('iframe')!;
    expect(iframe).not.toBeNull();
    const src = new URL(iframe.src);
    expect(src.origin + src.pathname).toBe('https://widget.acme.test/');
    expect(src.searchParams.get('key')).toBe('pk_live_abc');
    expect(src.searchParams.get('api')).toBe('https://api.acme.test');
  });

  it('reuses the same iframe across repeated opens rather than recreating it', () => {
    const handle = mountWidget(config, document);
    handle.open();
    const first = handle.host.shadowRoot!.querySelector('iframe');
    handle.close();
    handle.open();
    const second = handle.host.shadowRoot!.querySelector('iframe');
    expect(second).toBe(first);
  });

  it('toggles the iframe visibility between open and close', () => {
    const handle = mountWidget(config, document);
    handle.open();
    const iframe = handle.host.shadowRoot!.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.style.display).not.toBe('none');
    handle.close();
    expect(iframe.style.display).toBe('none');
  });

  it('clicking the launcher button toggles the widget open', () => {
    const handle = mountWidget(config, document);
    const button = handle.host.shadowRoot!.querySelector('button')!;
    button.click();
    expect(handle.host.shadowRoot!.querySelector('iframe')).not.toBeNull();
  });
});
