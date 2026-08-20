import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';

interface OrgSettings {
  welcomeMessage: string;
  suggestedQuestions: string[];
  systemPrompt: string | null;
  noAnswerMessage: string;
  minScore: number;
  topK: number;
}

interface WidgetKey {
  id: string;
  publicKey: string;
  allowedOrigins: string[];
  revokedAt: string | null;
}

const DEBOUNCE_MS = 600;
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const WIDGET_APP_URL = import.meta.env.VITE_WIDGET_APP_URL ?? 'http://localhost:5173';

export function WidgetConfigurator() {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.get<OrgSettings>('/v1/org-settings')
      .then(setSettings)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load settings'));

    api.get<WidgetKey[]>('/v1/widget-keys').then(async (keys) => {
      // Not just keys[0]: the preview iframe sends the dashboard's origin as
      // x-widget-origin, and the API 403s any key whose allowlist doesn't
      // cover it. Reusing an arbitrary key — one scoped to the customer's
      // real site, or a revoked one — makes the preview silently fall back to
      // the widget's built-in defaults, so it stops reflecting saved settings
      // while still looking like it works.
      const usable = keys.find(
        (k) => k.revokedAt === null && k.allowedOrigins.includes(window.location.origin),
      );
      if (usable) {
        setPreviewKey(usable.publicKey);
        return;
      }
      const created = await api.post<WidgetKey>('/v1/widget-keys', {
        name: 'Dashboard preview', allowedOrigins: [window.location.origin],
      });
      setPreviewKey(created.publicKey);
    }).catch((err) => setPreviewError(err instanceof ApiError ? err.message : 'Failed to load widget key'));

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function scheduleSave(next: OrgSettings) {
    setSettings(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.put<OrgSettings>('/v1/org-settings', next)
        .then(() => { setSaveError(null); setPreviewNonce((n) => n + 1); })
        .catch((err) => setSaveError(err instanceof ApiError ? err.message : 'Failed to save'));
    }, DEBOUNCE_MS);
  }

  if (loadError) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{loadError}</p>;
  if (!settings) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="flex gap-8">
      <form className="w-96 space-y-4" onSubmit={(e) => e.preventDefault()}>
        <h1 className="text-lg font-semibold">Widget configuration</h1>
        {saveError && <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{saveError}</p>}
        <div className="space-y-1">
          <label htmlFor="welcomeMessage" className="block text-sm font-medium text-gray-700">Welcome message</label>
          <textarea
            id="welcomeMessage" rows={2} value={settings.welcomeMessage}
            onChange={(e) => scheduleSave({ ...settings, welcomeMessage: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="noAnswerMessage" className="block text-sm font-medium text-gray-700">No-answer message</label>
          <textarea
            id="noAnswerMessage" rows={2} value={settings.noAnswerMessage}
            onChange={(e) => scheduleSave({ ...settings, noAnswerMessage: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="minScore" className="block text-sm font-medium text-gray-700">
            Relevance threshold ({settings.minScore.toFixed(2)})
          </label>
          <input
            id="minScore" type="range" min={0} max={1} step={0.01} value={settings.minScore}
            onChange={(e) => scheduleSave({ ...settings, minScore: Number(e.target.value) })}
            className="w-full"
          />
        </div>
      </form>
      <div className="flex-1">
        <h2 className="mb-2 text-sm font-medium text-gray-700">Live preview</h2>
        {previewError ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{previewError}</p>
        ) : previewKey ? (
          <iframe
            key={previewNonce}
            title="Widget preview"
            src={`${WIDGET_APP_URL}?api=${encodeURIComponent(API_URL)}&key=${encodeURIComponent(previewKey)}&origin=${encodeURIComponent(window.location.origin)}`}
            className="h-[600px] w-96 rounded-lg border border-gray-200"
          />
        ) : (
          <p className="text-gray-500">Preparing preview…</p>
        )}
      </div>
    </div>
  );
}
