import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { resolveLogTimeRange } from '../log-time-range';

describe('resolveLogTimeRange', () => {
  const oldCustomRange = [dayjs('2020-01-01T00:00:00Z'), dayjs('2020-01-02T00:00:00Z')] as const;

  it('drops a previously selected custom interval when All time is selected', () => {
    expect(resolveLogTimeRange('all', [...oldCustomRange])).toBeUndefined();
  });

  it('uses a selected custom interval only in custom mode', () => {
    expect(resolveLogTimeRange('custom', [...oldCustomRange])).toEqual({
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-02T00:00:00.000Z',
    });
  });

  it('leaves run-scoped all-time summaries without a time window', () => {
    expect(resolveLogTimeRange('all', null)).toBeUndefined();
  });
});
