import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DailyBarChart } from '../src/components/DailyBarChart.tsx';

describe('DailyBarChart', () => {
  it('renders one bar per data point', () => {
    render(<DailyBarChart data={[
      { date: '2026-08-01', value: 3 },
      { date: '2026-08-02', value: 7 },
    ]} />);
    // Each bar carries its value as an accessible label for screen readers.
    expect(screen.getAllByRole('img', { hidden: true })).toHaveLength(2);
    expect(screen.getByLabelText('2026-08-01: 3')).toBeInTheDocument();
    expect(screen.getByLabelText('2026-08-02: 7')).toBeInTheDocument();
  });

  it('renders an empty-state message with no data points', () => {
    render(<DailyBarChart data={[]} />);
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });
});
