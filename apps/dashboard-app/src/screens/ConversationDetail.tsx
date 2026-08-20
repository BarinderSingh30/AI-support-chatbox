import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';

interface TranscriptCitation {
  n: number;
  documentTitle: string;
  headingPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
}

interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  answered: boolean | null;
  topScore: number | null;
  createdAt: string;
  citations: TranscriptCitation[];
}

export function ConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get<{ id: string; messages: TranscriptMessage[] }>(`/v1/conversations/${id}`)
      .then((res) => setMessages(res.messages))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load conversation'));
  }, [id]);

  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;
  if (!messages) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">Conversation</h1>
      {messages.map((m) => (
        <div key={m.id} className={m.role === 'user' ? 'text-right' : 'text-left'}>
          <div
            className={
              'inline-block max-w-[85%] rounded-2xl px-3 py-2 ' +
              (m.role === 'user' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900')
            }
          >
            {m.content}
          </div>
          {m.citations.length > 0 && (
            <ul className="mt-1 space-y-1 text-left text-xs text-gray-500">
              {m.citations.map((c) => (
                <li key={c.n}>
                  [{c.n}] {c.documentTitle}
                  {c.headingPath ? ` — ${c.headingPath}` : ''}
                  {c.pageFrom ? ` (p. ${c.pageFrom})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
