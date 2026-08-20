import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { DailyBarChart } from '../components/DailyBarChart.tsx';

interface AnalyticsOverview {
  messagesByDay: { date: string; count: number }[];
  costByDay: { date: string; costUsd: number }[];
  answerRate: number;
  totalMessages: number;
  totalCostUsd: number;
}

interface UnansweredQuestion {
  content: string;
  frequency: number;
}

export function Analytics() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [unanswered, setUnanswered] = useState<UnansweredQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<AnalyticsOverview>('/v1/analytics/overview?days=30'),
      api.get<UnansweredQuestion[]>('/v1/analytics/unanswered?days=30&limit=20'),
    ])
      .then(([o, u]) => {
        setOverview(o);
        setUnanswered(u);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load analytics'));
  }, []);

  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>;
  if (!overview) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-lg font-semibold">Analytics — last 30 days</h1>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs uppercase text-gray-400">Messages</p>
          <p className="text-2xl font-semibold">{overview.totalMessages}</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs uppercase text-gray-400">Answer rate</p>
          <p className="text-2xl font-semibold">{Math.round(overview.answerRate * 100)}%</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-xs uppercase text-gray-400">Spend</p>
          <p className="text-2xl font-semibold">${overview.totalCostUsd.toFixed(4)}</p>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Messages per day</h2>
        <DailyBarChart data={overview.messagesByDay.map((d) => ({ date: d.date, value: d.count }))} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Spend per day</h2>
        <DailyBarChart
          data={overview.costByDay.map((d) => ({ date: d.date, value: d.costUsd }))}
          formatValue={(v) => `$${v.toFixed(4)}`}
        />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Top unanswered questions</h2>
        {unanswered.length === 0 ? (
          <p className="text-gray-500">No unanswered questions in this period.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2">Question</th>
                <th className="py-2">Asked</th>
              </tr>
            </thead>
            <tbody>
              {unanswered.map((q) => (
                <tr key={q.content} className="border-b border-gray-100">
                  <td className="py-2">{q.content}</td>
                  <td className="py-2">{q.frequency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
