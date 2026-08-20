import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const get = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  api: { get },
  ApiError: class ApiError extends Error { status = 0; },
}));

const { Analytics } = await import('../src/screens/Analytics.tsx');

afterEach(() => { cleanup(); get.mockReset(); });

describe('Analytics', () => {
  it('shows total messages, answer rate, and total cost', async () => {
    get.mockImplementation((path: string) => {
      if (path.includes('/overview')) {
        return Promise.resolve({
          messagesByDay: [{ date: '2026-08-01', count: 3 }],
          costByDay: [{ date: '2026-08-01', costUsd: 0.0012 }],
          answerRate: 0.75,
          totalMessages: 4,
          totalCostUsd: 0.0012,
        });
      }
      return Promise.resolve([{ content: 'Do you ship to Canada?', frequency: 2 }]);
    });
    render(<Analytics />);
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('$0.0012')).toBeInTheDocument();
  });

  it('lists top unanswered questions with their frequency', async () => {
    get.mockImplementation((path: string) => {
      if (path.includes('/overview')) {
        return Promise.resolve({
          messagesByDay: [], costByDay: [], answerRate: 1, totalMessages: 0, totalCostUsd: 0,
        });
      }
      return Promise.resolve([{ content: 'Do you ship to Canada?', frequency: 5 }]);
    });
    render(<Analytics />);
    await waitFor(() => expect(screen.getByText('Do you ship to Canada?')).toBeInTheDocument());
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
