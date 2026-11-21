import { InMemoryCache } from '@kb-labs/core-platform/inmemory';
import { describe, expect, it, vi } from 'vitest';
import { withLock } from '../services/workflow/engine/src/lock.js';

describe('admission lock safety', () => {
  it('does not allow two live critical sections when a holder is paused past its lease', async () => {
    vi.useFakeTimers();
    const cache = new InMemoryCache();
    let resumeFirst!: () => void;
    let firstEntered!: () => void;
    const paused = new Promise<void>((resolve) => { resumeFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let active = 0;
    let maximum = 0;
    const first = withLock(cache, 'admission', async () => {
      active++;
      maximum = Math.max(maximum, active);
      firstEntered();
      await paused;
      active--;
    });
    try {
      await entered;
      await vi.advanceTimersByTimeAsync(5001);
      await withLock(cache, 'admission', async () => {
        active++;
        maximum = Math.max(maximum, active);
        active--;
      });
      expect(maximum).toBe(1);
    } finally {
      resumeFirst();
      await first;
      vi.useRealTimers();
    }
  });
});
