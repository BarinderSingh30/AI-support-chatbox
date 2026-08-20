import { describe, expect, it, vi } from 'vitest';
import { streamChat, type ChatEvent } from '../src/lib/sse.ts';

/** Builds a Response whose body streams the given SSE text in arbitrary chunks. */
function sseResponse(text: string, chunkSize = 9999, status = 200): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

const SSE_BODY =
  'event: token\ndata: {"text":"Hello "}\n\n' +
  'event: token\ndata: {"text":"world"}\n\n' +
  'event: citations\ndata: {"citations":[{"n":1,"documentTitle":"Handbook"}]}\n\n' +
  'event: done\ndata: {"sessionId":"s1","answered":true}\n\n';

describe('streamChat', () => {
  it('sends the widget key, origin-relevant headers, and question in the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(SSE_BODY));
    await streamChat({
      apiUrl: 'https://api.acme.test', publicKey: 'pk_live_x', question: 'How long?',
      fetchImpl: fetchMock, onEvent: () => {},
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v1/widget/chat');
    expect(init.method).toBe('POST');
    expect(init.headers['x-widget-key']).toBe('pk_live_x');
    expect(JSON.parse(init.body).question).toBe('How long?');
  });

  it('emits token events in order as they arrive', async () => {
    const events: ChatEvent[] = [];
    await streamChat({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', question: 'q',
      fetchImpl: vi.fn().mockResolvedValue(sseResponse(SSE_BODY)),
      onEvent: (e) => events.push(e),
    });
    const tokens = events.filter((e) => e.type === 'token').map((e) => e.text);
    expect(tokens).toEqual(['Hello ', 'world']);
  });

  it('parses citations and the terminal done event', async () => {
    const events: ChatEvent[] = [];
    await streamChat({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', question: 'q',
      fetchImpl: vi.fn().mockResolvedValue(sseResponse(SSE_BODY)),
      onEvent: (e) => events.push(e),
    });
    const citations = events.find((e) => e.type === 'citations');
    expect(citations?.type === 'citations' && citations.citations[0]?.documentTitle).toBe('Handbook');
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.sessionId).toBe('s1');
  });

  it('handles an SSE event split arbitrarily across chunk boundaries', async () => {
    // A real network stream will not respect "event:"/"data:" line boundaries.
    const events: ChatEvent[] = [];
    await streamChat({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', question: 'q',
      fetchImpl: vi.fn().mockResolvedValue(sseResponse(SSE_BODY, 7)),
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === 'token').map((e) => e.text)).toEqual(['Hello ', 'world']);
  });

  it('reports a non-2xx response as an error event instead of throwing', async () => {
    const events: ChatEvent[] = [];
    await streamChat({
      apiUrl: 'https://api.acme.test', publicKey: 'bad', question: 'q',
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid widget key' }), { status: 401 })),
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([{ type: 'error', message: 'invalid widget key' }]);
  });

  it('reports a network failure as an error event', async () => {
    const events: ChatEvent[] = [];
    await streamChat({
      apiUrl: 'https://api.acme.test', publicKey: 'pk', question: 'q',
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('connect') }]);
  });
});
