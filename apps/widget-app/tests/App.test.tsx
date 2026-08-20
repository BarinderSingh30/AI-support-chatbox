import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App.tsx';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function sseResponse(text: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

const ANSWER_SSE =
  'event: token\ndata: {"text":"Refunds take "}\n\n' +
  'event: token\ndata: {"text":"14 days."}\n\n' +
  'event: citations\ndata: {"citations":[{"n":1,"documentTitle":"Handbook","headingPath":"Refunds","pageFrom":2,"excerpt":"Refunds are issued within 14 business days of receipt."}]}\n\n' +
  'event: done\ndata: {"sessionId":"s1","answered":true,"topScore":0.8,"costUsd":0.0003}\n\n';

const props = { apiUrl: 'https://api.acme.test', publicKey: 'pk_live_x' };

describe('App', () => {
  it('shows a welcome message and an input to ask a question', () => {
    render(<App {...props} fetchImpl={vi.fn()} />);
    const user = userEvent.setup();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('shows the visitor question immediately, before the answer arrives', async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'How long do refunds take?');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(screen.getByText('How long do refunds take?')).toBeInTheDocument();
  });

  it('streams the assistant answer and renders its citations', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'How long do refunds take?{Enter}');

    await waitFor(() => expect(screen.getByText(/Refunds take 14 days\./)).toBeInTheDocument());
    const citation = screen.getByRole('listitem');
    expect(within(citation).getByText(/Handbook/)).toBeInTheDocument();
    expect(within(citation).getByText(/p\. 2/)).toBeInTheDocument();
  });

  it('keeps the quoted passage collapsed until the citation is clicked', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByRole('listitem')).toBeInTheDocument());

    expect(screen.queryByText(/Refunds are issued within 14 business days/)).not.toBeInTheDocument();
  });

  it('reveals the quoted passage when a citation is clicked', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByRole('listitem')).toBeInTheDocument());

    // The whole point of a source citation is verifying the claim without
    // leaving the widget, so this is the feature's actual payoff.
    await user.click(screen.getByRole('button', { name: /Handbook/ }));
    expect(screen.getByText(/Refunds are issued within 14 business days/)).toBeInTheDocument();
  });

  it('collapses an expanded citation on a second click', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByRole('listitem')).toBeInTheDocument());

    const toggle = screen.getByRole('button', { name: /Handbook/ });
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByText(/Refunds are issued within 14 business days/)).not.toBeInTheDocument();
  });

  it('clears the input after sending', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(input, 'q{Enter}');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('disables the input while a request is in flight', async () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('does not send an empty question', async () => {
    const fetchImpl = vi.fn();
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shows a friendly message when the stream errors instead of crashing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403 }),
    );
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByText(/origin not allowed/i)).toBeInTheDocument());
  });

  it('re-enables the input once the answer finishes streaming', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  });

  it('forwards the embedding page\'s origin to every request', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} parentOrigin="https://client-site.test" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0]![1].headers['x-widget-origin']).toBe('https://client-site.test');
  });

  it('persists the session id so a second message continues the conversation', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(ANSWER_SSE)));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'first{Enter}');
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole('textbox'), 'second{Enter}');
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body);
    expect(secondBody.sessionId).toBe('s1');
  });
});
