import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const get = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  api: { get },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Imported after vi.mock so this resolves to the mocked class above — the
// component's `err instanceof ApiError` check must see the same constructor
// the test throws, or the error branch silently falls through to the generic
// fallback message and the assertion below would pass for the wrong reason.
const { ApiError } = await import('../src/lib/api.ts');
const { ConversationDetail } = await import('../src/screens/ConversationDetail.tsx');

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/conversations/${id}`]}>
      <Routes>
        <Route path="/conversations/:id" element={<ConversationDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); get.mockReset(); });

describe('ConversationDetail', () => {
  it('renders the transcript with roles, content, and citations', async () => {
    get.mockResolvedValue({
      id: 'sess-1',
      messages: [
        { id: 'm1', role: 'user', content: 'How long do refunds take?', answered: null, topScore: null, createdAt: '2026-08-01T00:00:00.000Z', citations: [] },
        {
          id: 'm2', role: 'assistant', content: 'Refunds take 14 days.', answered: true, topScore: 0.81,
          createdAt: '2026-08-01T00:00:05.000Z',
          citations: [{ n: 1, documentTitle: 'Handbook', headingPath: 'Refunds', pageFrom: 2, pageTo: 2, excerpt: 'Refunds are issued within 14 days.' }],
        },
      ],
    });
    renderAt('sess-1');
    await waitFor(() => expect(screen.getByText('How long do refunds take?')).toBeInTheDocument());
    expect(screen.getByText('Refunds take 14 days.')).toBeInTheDocument();
    expect(screen.getByText(/Handbook/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/conversations/sess-1');
  });

  it('shows a not-found message for a missing conversation', async () => {
    get.mockRejectedValue(new ApiError(404, 'conversation not found'));
    renderAt('missing');
    await waitFor(() => expect(screen.getByText(/conversation not found/i)).toBeInTheDocument());
  });
});
