import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('../src/lib/api.ts', () => ({
  api: { get, post, del },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { WidgetKeys } = await import('../src/screens/WidgetKeys.tsx');

const KEY = {
  id: 'k1', publicKey: 'pk_live_abc', name: 'Marketing site',
  allowedOrigins: ['https://acme.test'], rateLimitRpm: 20, monthlyMsgCap: 1000,
  revokedAt: null, createdAt: '2026-08-01T00:00:00.000Z',
};

afterEach(() => { cleanup(); get.mockReset(); post.mockReset(); del.mockReset(); });

describe('WidgetKeys', () => {
  it('lists existing keys with their allowed origins', async () => {
    get.mockResolvedValue([KEY]);
    render(<WidgetKeys />);
    await waitFor(() => expect(screen.getByText('pk_live_abc')).toBeInTheDocument());
    expect(screen.getByText('https://acme.test')).toBeInTheDocument();
  });

  it('shows an empty state with no keys', async () => {
    get.mockResolvedValue([]);
    render(<WidgetKeys />);
    await waitFor(() => expect(screen.getByText(/no widget keys yet/i)).toBeInTheDocument());
  });

  it('creates a new key from the form', async () => {
    get.mockResolvedValueOnce([]).mockResolvedValueOnce([KEY]);
    post.mockResolvedValue(KEY);
    render(<WidgetKeys />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/name/i), 'Marketing site');
    await user.type(screen.getByLabelText(/allowed origins/i), 'https://acme.test');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/widget-keys', {
      name: 'Marketing site', allowedOrigins: ['https://acme.test'],
    }));
  });

  it('revokes a key when Revoke is clicked', async () => {
    get.mockResolvedValueOnce([KEY]).mockResolvedValueOnce([]);
    del.mockResolvedValue(undefined);
    render(<WidgetKeys />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('pk_live_abc')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/widget-keys/k1'));
  });

  it('shows an error and keeps the key when revoke fails', async () => {
    const { ApiError } = await import('../src/lib/api.ts');
    get.mockResolvedValue([KEY]);
    del.mockRejectedValue(new ApiError(500, 'Revoke failed'));
    render(<WidgetKeys />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('pk_live_abc')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(screen.getByText('Revoke failed')).toBeInTheDocument());
    expect(screen.getByText('pk_live_abc')).toBeInTheDocument();
  });

  it('shows an error when create fails', async () => {
    const { ApiError } = await import('../src/lib/api.ts');
    get.mockResolvedValue([]);
    post.mockRejectedValue(new ApiError(400, 'Create failed'));
    render(<WidgetKeys />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/allowed origins/i), 'https://acme.test');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(screen.getByText('Create failed')).toBeInTheDocument());
  });
});
