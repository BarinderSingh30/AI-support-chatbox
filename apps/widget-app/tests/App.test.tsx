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

function configResponse(body: { welcomeMessage: string; suggestedQuestions: string[] }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const DEFAULT_CONFIG = { welcomeMessage: 'Hi! Ask me anything.', suggestedQuestions: [] };

/**
 * App fetches /v1/widget/config on mount in addition to /v1/widget/chat on
 * send. Dispatching on URL keeps that mount-time call from shifting the index
 * or count of every chat-specific assertion below — chatCalls tracks only the
 * chat endpoint, which is what most of these tests actually care about.
 */
function mockFetch(
  chatHandler: () => Response | Promise<Response> = () => sseResponse(''),
  config: { welcomeMessage: string; suggestedQuestions: string[] } = DEFAULT_CONFIG,
) {
  const chatCalls: [string, Record<string, unknown>][] = [];
  const fetchImpl = vi.fn((url: unknown, init?: unknown) => {
    if (typeof url === 'string' && url.includes('/v1/widget/config')) {
      return Promise.resolve(configResponse(config));
    }
    chatCalls.push([url as string, (init ?? {}) as Record<string, unknown>]);
    return Promise.resolve(chatHandler());
  });
  return { fetchImpl, chatCalls };
}

const ANSWER_SSE =
  'event: token\ndata: {"text":"Refunds take "}\n\n' +
  'event: token\ndata: {"text":"14 days."}\n\n' +
  'event: citations\ndata: {"citations":[{"n":1,"documentTitle":"Handbook","headingPath":"Refunds","pageFrom":2,"excerpt":"Refunds are issued within 14 business days of receipt."}]}\n\n' +
  'event: done\ndata: {"sessionId":"s1","answered":true,"topScore":0.8,"costUsd":0.0003}\n\n';

const props = { apiUrl: 'https://api.acme.test', publicKey: 'pk_live_x' };

describe('App', () => {
  it('shows a welcome message and an input to ask a question', () => {
    const { fetchImpl } = mockFetch();
    render(<App {...props} fetchImpl={fetchImpl} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('shows the visitor question immediately, before the answer arrives', async () => {
    const { fetchImpl } = mockFetch(() => new Promise(() => {})); // never resolves
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'How long do refunds take?');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(screen.getByText('How long do refunds take?')).toBeInTheDocument();
  });

  it('streams the assistant answer and renders its citations', async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'How long do refunds take?{Enter}');

    await waitFor(() => expect(screen.getByText(/Refunds take 14 days\./)).toBeInTheDocument());
    const citation = screen.getByRole('listitem');
    expect(within(citation).getByText(/Handbook/)).toBeInTheDocument();
    expect(within(citation).getByText(/p\. 2/)).toBeInTheDocument();
  });

  it('keeps the quoted passage collapsed until the citation is clicked', async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByRole('listitem')).toBeInTheDocument());

    expect(screen.queryByText(/Refunds are issued within 14 business days/)).not.toBeInTheDocument();
  });

  it('reveals the quoted passage when a citation is clicked', async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE));
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
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE));
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
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(input, 'q{Enter}');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('disables the input while a request is in flight', async () => {
    const { fetchImpl } = mockFetch(() => new Promise(() => {}));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('does not send an empty question', async () => {
    const { fetchImpl, chatCalls } = mockFetch();
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(chatCalls).toHaveLength(0);
  });

  it('shows a friendly message when the stream errors instead of crashing', async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403 }),
    );
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByText(/origin not allowed/i)).toBeInTheDocument());
  });

  it('re-enables the input once the answer finishes streaming', async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  });

  it("forwards the embedding page's origin to every chat request", async () => {
    const { fetchImpl, chatCalls } = mockFetch(() => sseResponse(ANSWER_SSE));
    render(<App {...props} parentOrigin="https://client-site.test" fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'q{Enter}');
    await waitFor(() => expect(chatCalls).toHaveLength(1));
    expect(chatCalls[0]![1].headers).toMatchObject({ 'x-widget-origin': 'https://client-site.test' });
  });

  it('persists the session id so a second message continues the conversation', async () => {
    const { fetchImpl, chatCalls } = mockFetch(() => sseResponse(ANSWER_SSE));
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'first{Enter}');
    await waitFor(() => expect(chatCalls).toHaveLength(1));

    await user.type(screen.getByRole('textbox'), 'second{Enter}');
    await waitFor(() => expect(chatCalls).toHaveLength(2));

    const secondBody = JSON.parse(chatCalls[1]![1].body as string);
    expect(secondBody.sessionId).toBe('s1');
  });
});

describe('App greeting and suggested questions', () => {
  it("shows the configured welcome message once it loads", async () => {
    const { fetchImpl } = mockFetch(undefined, {
      welcomeMessage: 'Hi! How can I help with Acme products?',
      suggestedQuestions: [],
    });
    render(<App {...props} fetchImpl={fetchImpl} />);
    await waitFor(() =>
      expect(screen.getByText('Hi! How can I help with Acme products?')).toBeInTheDocument(),
    );
  });

  it('shows the default greeting immediately, before the config call resolves', () => {
    // The chat must never look empty/broken while the config fetch is in
    // flight — the fallback text is what fills that gap.
    const { fetchImpl } = mockFetch(undefined);
    fetchImpl.mockImplementationOnce(() => new Promise(() => {})); // config never resolves
    render(<App {...props} fetchImpl={fetchImpl} />);
    expect(screen.getByText('Hi! Ask me anything.')).toBeInTheDocument();
  });

  it('renders each suggested question as a clickable chip', async () => {
    const { fetchImpl } = mockFetch(undefined, {
      welcomeMessage: 'Hi!',
      suggestedQuestions: ['What is your return policy?', 'How long is the warranty?'],
    });
    render(<App {...props} fetchImpl={fetchImpl} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'What is your return policy?' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'How long is the warranty?' })).toBeInTheDocument();
  });

  it('sends the exact chip text as a question when clicked', async () => {
    const { fetchImpl, chatCalls } = mockFetch(() => sseResponse(ANSWER_SSE), {
      welcomeMessage: 'Hi!',
      suggestedQuestions: ['How long is the warranty?'],
    });
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'How long is the warranty?' })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'How long is the warranty?' }));

    await waitFor(() => expect(chatCalls).toHaveLength(1));
    expect(JSON.parse(chatCalls[0]![1].body as string).question).toBe('How long is the warranty?');
    expect(screen.getByText('How long is the warranty?', { selector: 'div' })).toBeInTheDocument();
  });

  it('hides the greeting and chips once a conversation has started', async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(ANSWER_SSE), {
      welcomeMessage: 'Hi!',
      suggestedQuestions: ['How long is the warranty?'],
    });
    render(<App {...props} fetchImpl={fetchImpl} />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Hi!')).toBeInTheDocument());

    await user.type(screen.getByRole('textbox'), 'a different question{Enter}');

    await waitFor(() => expect(screen.queryByText('Hi!')).not.toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'How long is the warranty?' }),
    ).not.toBeInTheDocument();
  });

  it('shows no chips when none are configured, without erroring', async () => {
    const { fetchImpl } = mockFetch(undefined, { welcomeMessage: 'Hi!', suggestedQuestions: [] });
    render(<App {...props} fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByText('Hi!')).toBeInTheDocument());
    // Only Send remains — no stray suggestion buttons rendered from an empty list.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
