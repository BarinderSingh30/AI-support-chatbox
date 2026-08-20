import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const get = vi.fn();
const del = vi.fn();
const post = vi.fn();
const upload = vi.fn();

vi.mock('../src/lib/api.ts', () => ({
  api: { get, del, post, upload },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { Documents } = await import('../src/screens/Documents.tsx');

const ROW = {
  id: 'doc-1', title: 'Handbook.pdf', sourceType: 'pdf', status: 'ready',
  chunkCount: 12, tokenCount: 4000, pageCount: 8, byteSize: 20000,
  errorMessage: null, createdAt: '2026-08-01T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  get.mockReset(); del.mockReset(); post.mockReset(); upload.mockReset();
});

describe('Documents', () => {
  it('lists documents returned by the API', async () => {
    get.mockResolvedValue([ROW]);
    render(<Documents />);
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/documents');
  });

  it('shows an empty state with no documents', async () => {
    get.mockResolvedValue([]);
    render(<Documents />);
    await waitFor(() => expect(screen.getByText(/no documents yet/i)).toBeInTheDocument());
  });

  it('uploads a selected file and reloads the list', async () => {
    get.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    upload.mockResolvedValue({ id: 'doc-1', status: 'pending', duplicate: false });
    render(<Documents />);
    await waitFor(() => expect(screen.getByText(/no documents yet/i)).toBeInTheDocument());

    const file = new File(['content'], 'Handbook.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);

    await waitFor(() => expect(upload).toHaveBeenCalledWith('/v1/documents', expect.any(FormData)));
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());
  });

  it('deletes a document when Delete is clicked', async () => {
    get.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([]);
    del.mockResolvedValue(undefined);
    render(<Documents />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/documents/doc-1'));
  });

  it('triggers a re-embed when Re-embed is clicked', async () => {
    get.mockResolvedValue([ROW]);
    post.mockResolvedValue({ id: 'doc-1', status: 'pending' });
    render(<Documents />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /re-embed/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/documents/doc-1/reembed'));
  });

  it('shows an error and keeps the row when delete fails', async () => {
    const { ApiError } = await import('../src/lib/api.ts');
    get.mockResolvedValue([ROW]);
    del.mockRejectedValue(new ApiError(500, 'Delete failed'));
    render(<Documents />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(screen.getByText('Delete failed')).toBeInTheDocument());
    expect(screen.getByText('Handbook.pdf')).toBeInTheDocument();
  });

  it('shows an error when re-embed fails', async () => {
    const { ApiError } = await import('../src/lib/api.ts');
    get.mockResolvedValue([ROW]);
    post.mockRejectedValue(new ApiError(500, 'Re-embed failed'));
    render(<Documents />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Handbook.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /re-embed/i }));
    await waitFor(() => expect(screen.getByText('Re-embed failed')).toBeInTheDocument());
  });
});
