import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.ts';

function scriptWith(attrs: Record<string, string>): HTMLScriptElement {
  const el = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe('parseConfig', () => {
  it('reads the widget key and api url from data attributes', () => {
    const config = parseConfig(scriptWith({
      'data-key': 'pk_live_abc123', 'data-api': 'https://api.acme.test',
    }));
    expect(config).toEqual({
      publicKey: 'pk_live_abc123',
      apiUrl: 'https://api.acme.test',
      widgetUrl: expect.any(String),
    });
  });

  it('lets data-widget-url override the default', () => {
    const config = parseConfig(scriptWith({
      'data-key': 'pk_live_abc', 'data-api': 'https://api.acme.test',
      'data-widget-url': 'https://widget.acme.test',
    }));
    expect(config?.widgetUrl).toBe('https://widget.acme.test');
  });

  it('returns null and logs when data-key is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = parseConfig(scriptWith({ 'data-api': 'https://api.acme.test' }));
    expect(config).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('data-key'));
    spy.mockRestore();
  });

  it('returns null and logs when data-api is missing and no default is baked in', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = parseConfig(scriptWith({ 'data-key': 'pk_live_abc' }));
    expect(config).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('data-api'));
    spy.mockRestore();
  });

  it('returns null when the script element itself is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseConfig(null)).toBeNull();
    spy.mockRestore();
  });
});
