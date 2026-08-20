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
  reply.raw.writeHead(200, {
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
