import { vi } from 'vitest';
import { mockLogger } from '@kb-labs/shared-testing';
import { createNormalizedExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';

export function createWorkflowExecutionBackendFixture() {
  const execute = vi.fn(async () => ({
    ok: true as const,
    data: { status: 'success', outputs: {} },
    executionTimeMs: 0,
  }));
  const backend = createNormalizedExecutionBackend({
    execute,
    async health() { return { healthy: true, backend: 'in-process' }; },
    async stats() { return { totalExecutions: 0, successCount: 0, errorCount: 0, avgExecutionTimeMs: 0 }; },
    async shutdown() {},
  }, mockLogger(), 'in-process');
  return { backend, execute };
}
