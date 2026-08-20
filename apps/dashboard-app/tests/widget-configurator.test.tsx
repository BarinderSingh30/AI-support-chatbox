import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();

vi.mock('../src/lib/api.ts', () => ({
  api: { get, put, post },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { WidgetConfigurator } = await import('../src/screens/WidgetConfigurator.tsx');

const SETTINGS = {
  welcomeMessage: 'Hi! Ask me anything.', suggestedQuestions: [], systemPrompt: null,
  noAnswerMessage: "I couldn't find an answer to that.", minScore: 0.65, topK: 6,
};

// jsdom serves the app from window.location.origin; a preview key is only
// usable if its allowlist covers that exact origin (the API 403s otherwise).
const USABLE_KEY = {
  id: 'k1', publicKey: 'pk_live_x',
  allowedOrigins: [window.location.origin], revokedAt: null,
};

afterEach(() => { cleanup(); get.mockReset(); put.mockReset(); post.mockReset(); vi.useRealTimers(); });

describe('WidgetConfigurator', () => {
  it('loads current settings into the form and shows a live-preview iframe', async () => {
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([USABLE_KEY]));
    render(<WidgetConfigurator />);
    await waitFor(() => expect(screen.getByDisplayValue('Hi! Ask me anything.')).toBeInTheDocument());
    expect(screen.getByTitle(/widget preview/i)).toBeInTheDocument();
  });

  it('creates a widget key for preview when the org has none yet', async () => {
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([]));
    post.mockResolvedValue({ id: 'k1', publicKey: 'pk_live_new' });
    render(<WidgetConfigurator />);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/widget-keys', expect.objectContaining({
      name: 'Dashboard preview',
    })));
  });

  it('creates a preview key when existing keys do not allow the dashboard origin', async () => {
    // Regression: picking keys[0] blindly grabbed a key scoped to the
    // customer's own site, so /v1/widget/config 403'd and the preview
    // silently rendered the widget's built-in defaults instead of the
    // org's saved settings. Found by clicking through a real browser.
    const foreignKey = {
      id: 'k9', publicKey: 'pk_live_other',
      allowedOrigins: ['https://customer-site.test'], revokedAt: null,
    };
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([foreignKey]));
    post.mockResolvedValue({
      id: 'k2', publicKey: 'pk_live_new',
      allowedOrigins: [window.location.origin], revokedAt: null,
    });
    render(<WidgetConfigurator />);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/widget-keys', expect.objectContaining({
      allowedOrigins: [window.location.origin],
    })));
    const src = (await screen.findByTitle(/widget preview/i)).getAttribute('src')!;
    expect(new URL(src).searchParams.get('key')).toBe('pk_live_new');
  });

  it('does not reuse a revoked key for the preview', async () => {
    const revokedKey = {
      id: 'k8', publicKey: 'pk_live_dead',
      allowedOrigins: [window.location.origin], revokedAt: '2026-08-01T00:00:00.000Z',
    };
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([revokedKey]));
    post.mockResolvedValue({
      id: 'k2', publicKey: 'pk_live_fresh',
      allowedOrigins: [window.location.origin], revokedAt: null,
    });
    render(<WidgetConfigurator />);

    await waitFor(() => expect(post).toHaveBeenCalled());
    const src = (await screen.findByTitle(/widget preview/i)).getAttribute('src')!;
    expect(new URL(src).searchParams.get('key')).toBe('pk_live_fresh');
  });

  it('saves an edited welcome message after the debounce delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([USABLE_KEY]));
    put.mockResolvedValue({ ...SETTINGS, welcomeMessage: 'New greeting' });
    render(<WidgetConfigurator />);
    await waitFor(() => expect(screen.getByDisplayValue('Hi! Ask me anything.')).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    const input = screen.getByLabelText(/welcome message/i);
    await user.clear(input);
    await user.type(input, 'New greeting');

    await act(async () => { vi.advanceTimersByTime(700); });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/org-settings', expect.objectContaining({
      welcomeMessage: 'New greeting',
    })));
  });

  it('still shows the settings form when only the preview key fails to load', async () => {
    const { ApiError } = await import('../src/lib/api.ts');
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.reject(new ApiError(500, 'widget-keys unavailable')));
    render(<WidgetConfigurator />);
    await waitFor(() => expect(screen.getByDisplayValue('Hi! Ask me anything.')).toBeInTheDocument());
    expect(screen.getByText('widget-keys unavailable')).toBeInTheDocument();
    expect(screen.queryByTitle(/widget preview/i)).not.toBeInTheDocument();
  });

  it('includes the dashboard origin in the preview iframe src', async () => {
    get.mockImplementation((path: string) =>
      path.includes('org-settings') ? Promise.resolve(SETTINGS) : Promise.resolve([USABLE_KEY]));
    render(<WidgetConfigurator />);
    await waitFor(() => expect(screen.getByTitle(/widget preview/i)).toBeInTheDocument());
    const src = screen.getByTitle(/widget preview/i).getAttribute('src')!;
    expect(new URL(src).searchParams.get('origin')).toBe(window.location.origin);
  });
});
