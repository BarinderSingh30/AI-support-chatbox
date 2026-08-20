import { useEffect, useRef, useState } from 'react';
import { streamChat, type Citation } from './lib/sse.ts';
import { fetchWidgetConfig, DEFAULT_WIDGET_CONFIG, type WidgetConfig } from './lib/config.ts';
import { getOrCreateVisitorId, getStoredSessionId, storeSessionId } from './lib/visitor.ts';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  isError?: boolean;
}

export interface AppProps {
  apiUrl: string;
  publicKey: string;
  /** The embedding page's real origin, captured by the loader script. */
  parentOrigin?: string;
  /** Injected so tests never hit a real network. */
  fetchImpl?: typeof fetch;
}

export function App({ apiUrl, publicKey, parentOrigin, fetchImpl = fetch }: AppProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<WidgetConfig>(DEFAULT_WIDGET_CONFIG);
  const sessionId = useRef<string | undefined>(getStoredSessionId() ?? undefined);
  const visitorId = useRef(getOrCreateVisitorId());

  useEffect(() => {
    let cancelled = false;
    fetchWidgetConfig({ apiUrl, publicKey, parentOrigin, fetchImpl }).then((loaded) => {
      if (!cancelled) setConfig(loaded);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity of apiUrl/publicKey/fetchImpl is stable for the widget's lifetime
  }, []);

  async function send(override?: string) {
    const question = (override ?? input).trim();
    if (!question || busy) return;

    setInput('');
    setBusy(true);
    setMessages((prev) => [...prev, { role: 'user', content: question }]);

    let assistantIndex = -1;
    setMessages((prev) => {
      assistantIndex = prev.length;
      return [...prev, { role: 'assistant', content: '' }];
    });

    await streamChat({
      apiUrl, publicKey, question, parentOrigin,
      sessionId: sessionId.current,
      visitorId: visitorId.current,
      fetchImpl,
      onEvent(event) {
        setMessages((prev) => {
          const next = [...prev];
          const msg = { ...next[assistantIndex]! };
          if (event.type === 'token') {
            msg.content += event.text;
          } else if (event.type === 'citations') {
            msg.citations = event.citations;
          } else if (event.type === 'done') {
            sessionId.current = event.sessionId;
            storeSessionId(event.sessionId);
          } else if (event.type === 'error') {
            msg.content = event.message;
            msg.isError = true;
          }
          next[assistantIndex] = msg;
          return next;
        });
      },
    });

    setBusy(false);
  }

  return (
    <div className="flex h-full w-full flex-col bg-white font-sans text-sm text-gray-900">
      <header className="border-b border-gray-200 px-4 py-3">
        <h1 className="font-semibold">Support Chat</h1>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div>
            <p className="text-gray-700">{config.welcomeMessage}</p>
            {config.suggestedQuestions.length > 0 && (
              <div className="mt-3 flex flex-col items-start gap-2">
                {config.suggestedQuestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={busy}
                    className="rounded-full border border-gray-300 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    onClick={() => void send(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={
                'inline-block max-w-[85%] rounded-2xl px-3 py-2 ' +
                (m.role === 'user'
                  ? 'bg-gray-900 text-white'
                  : m.isError
                    ? 'bg-red-50 text-red-700'
                    : 'bg-gray-100 text-gray-900')
              }
            >
              {m.content || (m.role === 'assistant' && busy ? '…' : '')}
            </div>
            {m.citations && m.citations.length > 0 && (
              <ul className="mt-1 space-y-1 text-left text-xs text-gray-500">
                {m.citations.map((c) => {
                  const key = `${i}-${c.n}`;
                  const isOpen = expanded === key;
                  return (
                    <li key={c.n}>
                      <button
                        type="button"
                        className="text-left underline decoration-dotted hover:text-gray-700"
                        onClick={() => setExpanded(isOpen ? null : key)}
                      >
                        [{c.n}] {c.documentTitle}
                        {c.headingPath ? ` — ${c.headingPath}` : ''}
                        {c.pageFrom ? ` (p. ${c.pageFrom})` : ''}
                      </button>
                      {isOpen && (
                        <blockquote className="mt-1 rounded-md border-l-2 border-gray-300 bg-gray-50 px-2 py-1 text-gray-600">
                          {c.excerpt}
                        </blockquote>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>

      <form
        className="flex items-end gap-2 border-t border-gray-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-gray-500 disabled:opacity-50"
          rows={1}
          value={input}
          disabled={busy}
          placeholder="Ask a question…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
