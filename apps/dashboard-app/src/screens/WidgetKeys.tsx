import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';

interface WidgetKeyRow {
  id: string;
  publicKey: string;
  name: string | null;
  allowedOrigins: string[];
  rateLimitRpm: number;
  monthlyMsgCap: number;
  revokedAt: string | null;
  createdAt: string;
}

export function WidgetKeys() {
  const [keys, setKeys] = useState<WidgetKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');

  async function load() {
    setLoading(true);
    try {
      setKeys(await api.get<WidgetKeyRow[]>('/v1/widget-keys'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load widget keys');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const allowedOrigins = origins.split(',').map((o) => o.trim()).filter(Boolean);
    try {
      await api.post('/v1/widget-keys', { name: name || undefined, allowedOrigins });
      setName('');
      setOrigins('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create widget key');
    }
  }

  async function handleRevoke(id: string) {
    try {
      await api.del(`/v1/widget-keys/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke widget key');
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-lg font-semibold">Widget keys</h1>

      <form onSubmit={(e) => void handleCreate(e)} className="mb-6 flex items-end gap-3">
        <div className="flex-1 space-y-1">
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Name</label>
          <input
            id="name" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex-1 space-y-1">
          <label htmlFor="origins" className="block text-sm font-medium text-gray-700">Allowed origins</label>
          <input
            id="origins" value={origins} onChange={(e) => setOrigins(e.target.value)}
            placeholder="https://example.com, https://www.example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <button type="submit" className="rounded-lg bg-gray-900 px-4 py-2 text-white">Create</button>
      </form>

      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-gray-500">No widget keys yet.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Key</th>
              <th className="py-2">Name</th>
              <th className="py-2">Allowed origins</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b border-gray-100">
                <td className="py-2 font-mono text-xs">{key.publicKey}</td>
                <td className="py-2">{key.name ?? '—'}</td>
                <td className="py-2">{key.allowedOrigins.join(', ')}</td>
                <td className="py-2 text-right">
                  <button type="button" className="text-red-600 hover:underline" onClick={() => void handleRevoke(key.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
