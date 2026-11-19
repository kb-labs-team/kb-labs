import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  engineOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@kb-labs/workflow-engine", () => ({
  DAEMON_LEASE_HEARTBEAT_INTERVAL_MS: 60_000,
  createDefaultSecretProvider: () => ({}),
  requireWorkflowProjectId: (id: string) => id,
  WorkflowEngine: class {
    constructor(options: Record<string, unknown>) {
      mocks.engineOptions = options;
    }
    getStateStore() { return {}; }
    async cleanupStaleRuns() {}
    async resumeInterruptedJobs() {}
    async reconcileChildInvocations() { return 0; }
    async renewDaemonLease() {}
  },
  WorkflowService: class {
    async listAll() { return []; }
  },
}));

vi.mock("@kb-labs/core-runtime", () => ({
  requireProjectContext: (path: string) => path,
}));
vi.mock("@kb-labs/plugin-runtime", () => ({ makeAssemblyHook: () => ({}) }));
vi.mock("@kb-labs/shared-http", () => ({ getListenOptions: () => ({}) }));
vi.mock("@kb-labs/shared-daemon", () => ({ runService: vi.fn() }));
vi.mock("../worker.js", () => ({
  createWorkflowWorker: async () => ({ start: async () => {}, stop: async () => {} }),
}));
vi.mock("../job-broker.js", () => ({ JobBroker: class {} }));
vi.mock("../cron-scheduler.js", () => ({
  CronScheduler: class {
    async start() {}
    async stop() {}
  },
}));
vi.mock("../cron-discovery.js", () => ({
  CronDiscovery: class {
    async discoverAll() { return {}; }
  },
}));
vi.mock("../file-watcher.js", () => ({
  WorkflowFileWatcher: class {
    start() {}
    close() {}
  },
}));
vi.mock("../server.js", () => ({
  createServer: async () => ({ listen: async () => {}, close: async () => {} }),
}));

import { setup } from "../bootstrap.js";

describe("workflow analytics adapter wiring", () => {
  afterEach(() => {
    mocks.engineOptions = undefined;
  });

  // case: S-254.1, S-254.2
  it("provides platform analytics to the engine that emits run lifecycle events", async () => {
    const analytics = { track: vi.fn(async () => {}) };
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      forComponent() { return this; },
      forOperation() { return this; },
      with() { return this; },
    };
    const platform = {
      isConfigured: () => true,
      cache: {}, storage: {}, eventBus: {}, analytics, snapshotManager: {},
    };
    const stop = await setup({
      platform,
      runtime: { catalog: { listPlugins: async () => [] } },
      port: 7778,
      host: "127.0.0.1",
      projectRoot: "/registered/project",
      projectId: "prj_1234567890123456",
      platformRoot: "/platform",
      activeWork: { register: () => () => {} },
      logger,
    } as never);

    expect(mocks.engineOptions?.analytics).toBe(analytics);
    await stop();
  });
});
