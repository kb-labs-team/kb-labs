import { describe, expect, it } from 'vitest';
import { workflowDeadLetterCacheKey } from '../dead-letter-key.js';
import { workflowProjectCacheKey } from '../project-scoped-cache.js';

describe('workflowDeadLetterCacheKey', () => {
  it('keeps project-scoped keys within the state broker path parameter limit for reruns', () => {
    const originalRunId = 'b16ebbdb-4bbe-4821-9cde-725de581a6dd';
    const rerunJobId = `${originalRunId}:rerun`;
    const key = workflowProjectCacheKey(
      'prj_b63db57b5b4b1f64',
      workflowDeadLetterCacheKey(originalRunId, rerunJobId),
    );

    expect(encodeURIComponent(key).length).toBeLessThanOrEqual(100);
    expect(workflowDeadLetterCacheKey(originalRunId, rerunJobId))
      .not.toBe(workflowDeadLetterCacheKey(originalRunId, `${originalRunId}:other`));
  });
});
