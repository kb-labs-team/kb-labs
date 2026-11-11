import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock('../../../src/core/stats/index.js', () => ({
  calculateStats: vi.fn(),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useCache: vi.fn(),
  };
});

import { calculateStats } from '../../../src/core/stats/index.js';
import { useCache } from '@kb-labs/sdk';
import statsHandler from '../../../src/rest/handlers/stats-handler.js';

const MOCK_STATS = { packages: 206, loc: 540_000, sizeFormatted: '16.10 MB' };
const MOCK_RESULT = { packages: 206, loc: 540_000, size: '16.10 MB' };
const CTX = { cwd: '/project' } as never;
const INPUT = {} as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(calculateStats).mockResolvedValue({ ...MOCK_STATS, size: 16_000_000 } as never);
  vi.mocked(useCache).mockReturnValue(mockCache as never);
  mockCache.get.mockResolvedValue(null);
  mockCache.set.mockResolvedValue(undefined);
});

describe('stats-handler', () => {
  describe('cache hit', () => {
    it('STATS-01: returns cached result without calling calculateStats', async () => {
      mockCache.get.mockResolvedValue(MOCK_RESULT);

      const result = await statsHandler.execute(CTX, INPUT);

      expect(result).toEqual(MOCK_RESULT);
      expect(calculateStats).not.toHaveBeenCalled();
      expect(mockCache.set).not.toHaveBeenCalled();
    });
  });

  describe('cache miss', () => {
    it('STATS-02: computes stats, stores in cache with 5min TTL, returns result', async () => {
      mockCache.get.mockResolvedValue(null);

      const result = await statsHandler.execute(CTX, INPUT);

      expect(calculateStats).toHaveBeenCalledWith('/project');
      expect(mockCache.set).toHaveBeenCalledWith('quality:stats', MOCK_RESULT, 5 * 60 * 1000);
      expect(result).toEqual(MOCK_RESULT);
    });

    it('STATS-03: result shape has packages, loc, size (string)', async () => {
      const result = await statsHandler.execute(CTX, INPUT) as typeof MOCK_RESULT;

      expect(typeof result.packages).toBe('number');
      expect(typeof result.loc).toBe('number');
      expect(typeof result.size).toBe('string');
    });
  });

  describe('no cache adapter', () => {
    it('STATS-04: computes and returns stats without caching when cache unavailable', async () => {
      vi.mocked(useCache).mockReturnValue(undefined);

      const result = await statsHandler.execute(CTX, INPUT);

      expect(calculateStats).toHaveBeenCalledWith('/project');
      expect(mockCache.set).not.toHaveBeenCalled();
      expect(result).toEqual(MOCK_RESULT);
    });
  });
});
