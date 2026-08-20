import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initFromScript } from '../src/index.ts';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('initFromScript', () => {
  it('mounts the widget using the currently executing script tag', () => {
    const script = document.createElement('script');
    script.setAttribute('data-key', 'pk_live_abc');
    script.setAttribute('data-api', 'https://api.acme.test');
    document.body.appendChild(script);

    initFromScript(script);

    expect(document.querySelector('[data-groundwork-widget]')).not.toBeNull();
  });

  it('mounts nothing and logs when the script tag has no data-key', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const script = document.createElement('script');
    document.body.appendChild(script);

    initFromScript(script);

    expect(document.querySelector('[data-groundwork-widget]')).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
