import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const get = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  api: { get },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { Conversations } = await import('../src/screens/Conversations.tsx');

afterEach(() => { cleanup(); get.mockReset(); });

describe('Conversations', () => {
  it('lists sessions with a visitor id, origin, and message count', async () => {
    get.mockResolvedValue([{
      id: 'sess-1', visitorId: 'v-123', origin: 'https://acme.test',
      startedAt: '2026-08-01T00:00:00.000Z', lastMessageAt: '2026-08-01T00:05:00.000Z',
      messageCount: 4,
    }]);
    render(<MemoryRouter><Conversations /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('v-123')).toBeInTheDocument());
    expect(screen.getByText('https://acme.test')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /v-123/ })).toHaveAttribute('href', '/conversations/sess-1');
  });

  it('shows an empty state with no conversations', async () => {
    get.mockResolvedValue([]);
    render(<MemoryRouter><Conversations /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/no conversations yet/i)).toBeInTheDocument());
  });
});
