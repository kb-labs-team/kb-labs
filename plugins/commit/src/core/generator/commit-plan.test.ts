import { describe, expect, it, vi } from 'vitest';
import { useLogger } from '@kb-labs/sdk';
import { retryLLMCall } from './commit-plan.js';

describe('Commit LLM cancellation', () => {
  // case: S-030.3
  it('does not retry a cancelled text completion or report fallback progress', async () => {
    const abort = new Error('request cancelled');
    abort.name = 'AbortError';
    const complete = vi.fn().mockRejectedValue(abort);
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as ReturnType<typeof useLogger>;
    const onProgress = vi.fn();

    await expect(retryLLMCall(() => complete(), 'Phase 1', logger, onProgress)).rejects.toBe(abort);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
