import { describe, expect, it, vi } from 'vitest';
import { fetchWidgetConfig, DEFAULT_WIDGET_CONFIG } from '../src/lib/config.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchWidgetConfig', () => {
  it('requests the config endpoint with the widget key and parent origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ welcomeMessage: 'Hi!', suggestedQuestions: [] }),
    );
    await fetchWidgetConfig({
      apiUrl: 'https://api.acme.test', publicKey: 'pk_live_x',
      parentOrigin: 'https://client.test', fetchImpl: fetchMock,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v1/widget/config');
    expect(init.method).toBe('GET');
    expect(init.headers['x-widget-key']).toBe('pk_live_x');
    expect(init.headers['x-widget-origin']).toBe('https://client.test');
  });

  it('returns the parsed welcome message and suggested questions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ welcomeMessage: 'Hi! Ask away.', suggestedQuestions: ['Q1', 'Q2'] }),
    );
    const config = await fetchWidgetConfig({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', fetchImpl: fetchMock,
    });
    expect(config).toEqual({ welcomeMessage: 'Hi! Ask away.', suggestedQuestions: ['Q1', 'Q2'] });
  });

  it('falls back to a default when the server rejects the request', async () => {
    // A widget must still be usable — with a generic greeting — even if its
    // key is briefly invalid or the origin check fails for some reason;
    // failing to load a greeting should never block the chat from opening.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'origin not allowed' }, 403));
    const config = await fetchWidgetConfig({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', fetchImpl: fetchMock,
    });
    expect(config).toEqual(DEFAULT_WIDGET_CONFIG);
  });

  it('falls back to a default when the network request itself fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const config = await fetchWidgetConfig({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', fetchImpl: fetchMock,
    });
    expect(config).toEqual(DEFAULT_WIDGET_CONFIG);
  });
});
