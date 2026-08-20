export interface Citation {
  n: number;
  documentTitle: string;
  headingPath?: string | null;
  pageFrom?: number | null;
  excerpt: string;
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done'; sessionId: string; answered: boolean; topScore: number; costUsd: number }
  | { type: 'error'; message: string };

export interface StreamChatInput {
  apiUrl: string;
  publicKey: string;
  question: string;
  sessionId?: string;
  visitorId?: string;
  /**
   * The embedding page's real origin, captured by the loader script (which
   * runs directly in that page's context) and forwarded here. The browser's
   * own Origin header on this fetch always reports the CHAT IFRAME's origin
   * instead — never the parent page's — so it cannot be used for this.
   */
  parentOrigin?: string;
  fetchImpl: typeof fetch;
  onEvent: (event: ChatEvent) => void;
}

/**
 * Parses one SSE frame ("event: x\ndata: y") into a typed ChatEvent.
 * Unknown event names are ignored rather than thrown on, so a future server
 * field addition can't crash an older cached widget bundle.
 */
function parseFrame(frame: string): ChatEvent | null {
  const eventMatch = /^event: (.+)$/m.exec(frame);
  const dataMatch = /^data: (.+)$/m.exec(frame);
  if (!eventMatch || !dataMatch) return null;

  const data = JSON.parse(dataMatch[1]!);
  switch (eventMatch[1]) {
    case 'token': return { type: 'token', text: data.text };
    case 'citations': return { type: 'citations', citations: data.citations };
    case 'done': return { type: 'done', ...data };
    case 'error': return { type: 'error', message: data.error };
    default: return null;
  }
}

/**
 * Reads a fetch Response body as SSE, emitting one ChatEvent per frame.
 *
 * A real network stream will not respect "event:"/"data:" line boundaries —
 * frames can split across chunks — so this buffers until a full "\n\n"
 * separated frame is available before parsing it.
 */
async function consumeSseBody(response: Response, onEvent: (e: ChatEvent) => void): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseFrame(frame);
      if (event) onEvent(event);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/**
 * Public-key-authenticated chat request against the widget endpoint.
 *
 * Never throws: every failure — a rejected fetch, a non-2xx response, a
 * malformed body — is normalized into an `error` ChatEvent, so a single
 * onEvent handler in the UI covers every outcome.
 */
export async function streamChat(input: StreamChatInput): Promise<void> {
  const { apiUrl, publicKey, question, sessionId, visitorId, parentOrigin, fetchImpl, onEvent } = input;

  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/v1/widget/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-widget-key': publicKey,
        ...(parentOrigin ? { 'x-widget-origin': parentOrigin } : {}),
      },
      body: JSON.stringify({ question, sessionId, visitorId }),
    });
  } catch {
    onEvent({ type: 'error', message: 'Could not connect. Please check your connection and try again.' });
    return;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    onEvent({ type: 'error', message: body.error ?? `Request failed (${response.status})` });
    return;
  }

  await consumeSseBody(response, onEvent);
}
