import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  config: undefined as { tokenBudget?: { enabled?: boolean; maxTokens?: number } } | undefined,
  runnerConfig: undefined as { tokenBudget?: { enabled?: boolean; maxTokens?: number } } | undefined,
}));

vi.mock('@kb-labs/sdk', () => ({
  defineCommand: (command: unknown) => command,
  useAnalytics: () => null,
  useCache: () => null,
  useConfig: async () => harness.config,
}));

vi.mock('../../../src/core/index.js', () => ({
  SessionManager: class {
    async createSession() { return { id: 'session-test' }; }
    async createUserTurn() {}
    async addEvent() {}
    async storeTraceArtifacts() {}
    async attachFileChangesToTurn() {}
  },
  PlanDocumentService: class {},
  SpecModeHandler: class {},
  bootstrapAgentSDK: () => {},
  createSessionMemoryBridge: () => ({}),
  createCoreToolPack: () => ({}),
}));

vi.mock('../../../src/sdk/index.js', () => ({
  AgentSDK: class {
    register() {}
    createRunner(config: typeof harness.runnerConfig) {
      harness.runnerConfig = config;
      return { execute: async () => ({ success: true, summary: 'done', iterations: 1, tokensUsed: 0 }) };
    }
  },
}));

vi.mock('../../../src/runtime/index.js', () => ({
  createDefaultResponseRequirementsSelector: () => ({ select: async () => ({}) }),
}));

vi.mock('../../../src/tracing/index.js', () => ({
  IncrementalTraceWriter: class {
    trace() {}
    getEntries() { return []; }
    async finalize() {}
  },
}));

vi.mock('../../../src/tools/index.js', () => ({ createToolRegistry: () => ({}) }));
vi.mock('../../../src/cli/ui/index.js', () => ({
  createEventRenderer: () => () => {},
  createMinimalRenderer: () => () => {},
  createDetailedRenderer: () => () => {},
  createDebugRenderer: () => () => {},
}));

import runCommand from '../../../src/cli/commands/run.js';

describe('agent run token budget CLI precedence', () => {
  beforeEach(() => {
    harness.config = undefined;
    harness.runnerConfig = undefined;
  });

  // case: S-299.1
  it('passes the CLI budget override to the regular runner ahead of plugin config', async () => {
    harness.config = { tokenBudget: { enabled: true, maxTokens: 42_000 } };
    await runCommand.handler.execute({ cwd: process.cwd() } as never, {
      task: 'inspect only', budget: 12_000, json: true,
    } as never);
    expect(harness.runnerConfig?.tokenBudget).toEqual({ enabled: true, maxTokens: 12_000 });
  });

  // case: S-299.2
  it('passes the configured budget when the CLI does not override it', async () => {
    harness.config = { tokenBudget: { enabled: true, maxTokens: 42_000 } };
    await runCommand.handler.execute({ cwd: process.cwd() } as never, { task: 'inspect only', json: true } as never);
    expect(harness.runnerConfig?.tokenBudget).toEqual({ enabled: true, maxTokens: 42_000 });
  });

  // case: S-299.3
  it('leaves the budget unset when neither CLI nor plugin config provides one', async () => {
    await runCommand.handler.execute({ cwd: process.cwd() } as never, { task: 'inspect only', json: true } as never);
    expect(harness.runnerConfig?.tokenBudget).toBeUndefined();
  });
});
