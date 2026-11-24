import dayjs, { type Dayjs } from 'dayjs';

export const TIME_RANGES = {
  all: { label: 'All time', minutes: 0 },
  '5m': { label: 'Last 5 minutes', minutes: 5 },
  '15m': { label: 'Last 15 minutes', minutes: 15 },
  '1h': { label: 'Last hour', minutes: 60 },
  '6h': { label: 'Last 6 hours', minutes: 360 },
  '24h': { label: 'Last 24 hours', minutes: 1440 },
  custom: { label: 'Custom range', minutes: 0 },
};

export interface LogTimeRange {
  from: string;
  to: string;
}

export function resolveLogTimeRange(
  timeRange: string,
  customTimeRange: [Dayjs, Dayjs] | null,
  now = dayjs(),
): LogTimeRange | undefined {
  if (timeRange === 'all') {return undefined;}
  if (timeRange === 'custom') {
    return customTimeRange
      ? { from: customTimeRange[0].toISOString(), to: customTimeRange[1].toISOString() }
      : undefined;
  }

  const rangeMinutes = TIME_RANGES[timeRange as keyof typeof TIME_RANGES]?.minutes ?? 15;
  return { from: now.subtract(rangeMinutes, 'minutes').toISOString(), to: now.toISOString() };
}
