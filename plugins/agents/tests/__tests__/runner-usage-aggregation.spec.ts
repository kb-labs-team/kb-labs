import { describe, expect, it, vi } from 'vitest';
import { SDKAgentRunner } from '../../src/core/core/runner.js';
import { AgentSDK } from '../../src/sdk/index.js';

describe('SDKAgentRunner token usage aggregation', () => {
  it('keeps aggregate usage unknown when a tier result has no measurement', async () => {
    const runner = new SDKAgentRunner({
      workingDir: '/tmp/agents-usage-aggregation',
      maxIterations: 1,
      temperature: 0,
      analytics: { track: vi.fn(async () => undefined) },
    }, new AgentSDK());
    const tierResult = {
      success: true,
      summary: 'completed',
      filesCreated: [],
      filesModified: [],
      filesRead: [],
      iterations: 1,
      _metrics: {
        durationMs: 1,
        toolCallsTotal: 0,
        toolSuccessCount: 0,
        toolErrorCount: 0,
      },
    };
    Object.defineProperty(runner, 'executeWithTier', {
      value: async () => tierResult,
    });

    const result = await runner.execute('test usage aggregation');

    expect(result.tokensUsed).toBeUndefined();
    expect(result.usage?.totalTokens).toBeUndefined();
  });
});
