export interface DailyBarChartPoint {
  date: string;
  value: number;
}

export interface DailyBarChartProps {
  data: DailyBarChartPoint[];
  formatValue?: (value: number) => string;
}

const HEIGHT = 120;
const BAR_GAP = 4;

export function DailyBarChart({ data, formatValue = String }: DailyBarChartProps) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-400">No data for this period.</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = Math.max(100 / data.length - BAR_GAP / 4, 1);

  return (
    <svg
      viewBox={`0 0 100 ${HEIGHT}`}
      preserveAspectRatio="none"
      className="h-32 w-full"
      role="group"
      aria-label="Daily values"
    >
      {data.map((point, i) => {
        const barHeight = (point.value / max) * (HEIGHT - 16);
        const x = i * (100 / data.length);
        return (
          <rect
            key={point.date}
            x={x}
            y={HEIGHT - barHeight}
            width={barWidth}
            height={barHeight}
            className="fill-gray-700"
            role="img"
            aria-label={`${point.date}: ${formatValue(point.value)}`}
          >
            <title>{`${point.date}: ${formatValue(point.value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
