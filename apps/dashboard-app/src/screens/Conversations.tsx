import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';

interface ConversationRow {
  id: string;
  visitorId: string | null;
  origin: string | null;
  startedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
}

export function Conversations() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<ConversationRow[]>('/v1/conversations')
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load conversations'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-500">Loading…</p>;
  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Conversations</h1>
      {rows.length === 0 ? (
        <p className="text-gray-500">No conversations yet.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Visitor</th>
              <th className="py-2">Origin</th>
              <th className="py-2">Last message</th>
              <th className="py-2">Messages</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-gray-100">
                <td className="py-2">
                  <Link to={`/conversations/${row.id}`} className="text-gray-900 underline decoration-dotted hover:text-gray-600">
                    {row.visitorId ?? row.id}
                  </Link>
                </td>
                <td className="py-2">{row.origin ?? '—'}</td>
                <td className="py-2">{row.lastMessageAt ? new Date(row.lastMessageAt).toLocaleString() : '—'}</td>
                <td className="py-2">{row.messageCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
