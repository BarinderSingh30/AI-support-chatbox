import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { AnswerInput, AnswerResult } from './answer.ts';
import { answerQuestion } from './answer.ts';

/**
 * Runs answerQuestion and writes it out as Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives
 * proxies that mangle upgrades, and the browser reconnects on its own. Shared
 * between the session-authenticated and widget-key-authenticated chat routes
 * so the wire format cannot drift between them.
 */
export async function streamAnswer(
  reply: FastifyReply,
  input: AnswerInput,
): Promise<AnswerResult | null> {
  // reply.raw.writeHead() writes directly to the raw Node response and
  // completely discards anything queued via Fastify's own reply.header() —
  // including CORS headers set by an onRequest hook upstream (both the
  // public widget route's own hook and @fastify/cors on the session route).
  // Without carrying those over, a preflight OPTIONS request passes (it goes
  // through Fastify's normal reply pipeline) while the actual streamed
  // response silently ships with no Access-Control-Allow-Origin — a real
  // browser rejects the fetch outright, but curl and any tool that doesn't
  // enforce CORS won't show anything wrong. Caught only by an actual browser
  // click; see docs/phases/phase-3-widget.md.
  const upstreamHeaders: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) upstreamHeaders[key] = String(value);
  }

  reply.raw.writeHead(200, {
    ...upstreamHeaders,
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends buffer streamed responses by default, defeating the
    // point of streaming.
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const gen = answerQuestion(input);
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === 'token') send('token', { text: next.value.text });
      else send('citations', { citations: next.value.citations });
      next = await gen.next();
    }
    send('done', {
      sessionId: next.value.sessionId,
      messageId: next.value.messageId,
      answered: next.value.answered,
      topScore: next.value.topScore,
      latencyMs: next.value.latencyMs,
      costUsd: Number(next.value.costUsd.toFixed(6)),
    });
    return next.value;
  } catch (error) {
    reply.log.error({ err: error }, 'chat stream failed');
    send('error', { error: 'answer generation failed' });
    return null;
  } finally {
    reply.raw.end();
  }
}
