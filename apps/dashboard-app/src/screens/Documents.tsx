import { useEffect, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';

interface DocumentRow {
  id: string;
  title: string;
  sourceType: string;
  status: string;
  chunkCount: number;
  tokenCount: number;
  pageCount: number | null;
  byteSize: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export function Documents() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setDocuments(await api.get<DocumentRow[]>('/v1/documents'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.upload('/v1/documents', form);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.del(`/v1/documents/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed');
    }
  }

  async function handleReembed(id: string) {
    try {
      await api.post(`/v1/documents/${id}/reembed`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Re-embed failed');
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Documents</h1>
        <label className="cursor-pointer rounded-lg bg-gray-900 px-4 py-2 text-white">
          {uploading ? 'Uploading…' : 'Upload document'}
          <input
            type="file" accept=".pdf,.txt,.md" className="hidden"
            onChange={(e) => void handleUpload(e)} disabled={uploading}
          />
        </label>
      </div>
      {error && <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : documents.length === 0 ? (
        <p className="text-gray-500">No documents yet. Upload one to get started.</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2">Title</th>
              <th className="py-2">Status</th>
              <th className="py-2">Chunks</th>
              <th className="py-2">Pages</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b border-gray-100">
                <td className="py-2">{doc.title}</td>
                <td className="py-2">
                  {doc.status}
                  {doc.errorMessage && <span className="ml-2 text-xs text-red-600">{doc.errorMessage}</span>}
                </td>
                <td className="py-2">{doc.chunkCount}</td>
                <td className="py-2">{doc.pageCount ?? '—'}</td>
                <td className="space-x-3 py-2 text-right">
                  <button type="button" className="text-gray-600 hover:underline" onClick={() => void handleReembed(doc.id)}>
                    Re-embed
                  </button>
                  <button type="button" className="text-red-600 hover:underline" onClick={() => void handleDelete(doc.id)}>
                    Delete
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
