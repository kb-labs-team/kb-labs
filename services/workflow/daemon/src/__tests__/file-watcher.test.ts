import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mockLogger } from '@kb-labs/shared-testing';

// --- fs mocks must be set up before importing the module under test ---

const mockWatcher = new EventEmitter() as FSWatcher & EventEmitter;
mockWatcher.close = vi.fn();

vi.mock('node:fs', () => ({
  watch: vi.fn(() => mockWatcher),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
}));

import { watch } from 'node:fs';
import { WorkflowFileWatcher } from '../file-watcher.js';

type WatchCallback = (event: string, filename: string) => void;

function getWatchCallback(callIndex = 0): WatchCallback {
  const calls = vi.mocked(watch).mock.calls as unknown as [unknown, unknown, WatchCallback][];
  const cb = calls[callIndex]?.[2];
  if (!cb) { throw new Error(`watch() was not called (index ${callIndex})`); }
  return cb;
}

// ---------- helpers ----------


function makeWorkflowService() {
  return { refreshManifests: vi.fn().mockResolvedValue(undefined) };
}

function makeCronDiscovery() {
  return { discoverAll: vi.fn().mockResolvedValue({ plugins: 0, users: 1 }) };
}

function makeCronScheduler() {
  return { clearUserJobs: vi.fn() };
}

function makeWatcher(overrides: Partial<ConstructorParameters<typeof WorkflowFileWatcher>[0]> = {}) {
  const logger = mockLogger();
  const workflowService = makeWorkflowService();
  const cronDiscovery = makeCronDiscovery();
  const cronScheduler = makeCronScheduler();

  const fw = new WorkflowFileWatcher({
    watchDirs: ['/project/.kb/workflows'],
    workflowService: workflowService as any,
    cronDiscovery: cronDiscovery as any,
    cronScheduler: cronScheduler as any,
    logger,
    debounceMs: 0, // no delay in tests
    ...overrides,
  });

  return { fw, logger, workflowService, cronDiscovery, cronScheduler };
}

// ---------- tests ----------

describe('WorkflowFileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    (mockWatcher as EventEmitter).removeAllListeners();
  });

  it('calls refreshManifests and discoverAll when a yaml file changes', async () => {
    const { workflowService, cronDiscovery, cronScheduler } = makeWatcher();

    // Wait for the access() promise to resolve so the watcher is registered.
    await vi.runAllTimersAsync();

    const watchFn = vi.mocked(watch);
    expect(watchFn).toHaveBeenCalledWith(
      '/project/.kb/workflows',
      { persistent: false },
      expect.any(Function),
    );

    // Simulate a file change event via the callback passed to watch().
    const callback = getWatchCallback();
    callback('change', 'my-workflow.yaml');

    await vi.runAllTimersAsync();

    expect(workflowService.refreshManifests).toHaveBeenCalledTimes(1);
    expect(cronScheduler.clearUserJobs).toHaveBeenCalledTimes(1);
    expect(cronDiscovery.discoverAll).toHaveBeenCalledTimes(1);
  });

  it('ignores non-yaml file changes', async () => {
    const { workflowService } = makeWatcher();

    await vi.runAllTimersAsync();

    const callback = getWatchCallback();
    callback('change', 'README.md');

    await vi.runAllTimersAsync();

    expect(workflowService.refreshManifests).not.toHaveBeenCalled();
  });

  it('coalesces rapid changes into a single reload (debounce)', async () => {
    const { workflowService } = makeWatcher({ debounceMs: 50 });

    await vi.runAllTimersAsync();

    const callback = getWatchCallback();

    // Rapid-fire three saves.
    callback('change', 'wf.yaml');
    callback('change', 'wf.yaml');
    callback('change', 'wf.yaml');

    await vi.runAllTimersAsync();

    expect(workflowService.refreshManifests).toHaveBeenCalledTimes(1);
  });

  it('close() stops the watcher and cancels pending debounce', async () => {
    const { fw, workflowService } = makeWatcher({ debounceMs: 200 });

    await vi.runAllTimersAsync();

    const callback = getWatchCallback();
    callback('change', 'wf.yaml');

    // Close before debounce fires.
    fw.close();

    await vi.runAllTimersAsync();

    expect(mockWatcher.close).toHaveBeenCalled();
    expect(workflowService.refreshManifests).not.toHaveBeenCalled();
  });

  it('attaches when a watched directory is created after startup', async () => {
    const { access } = await import('node:fs/promises');
    vi.mocked(access).mockRejectedValueOnce(new Error('ENOENT'));

    const { workflowService, logger } = makeWatcher();

    await vi.runAllTimersAsync();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('does not exist'),
      expect.any(Object),
    );

    expect(vi.mocked(watch)).toHaveBeenCalledWith(
      '/project/.kb',
      { persistent: false },
      expect.any(Function),
    );

    // Creating .kb/workflows causes the child watcher to attach; later YAML
    // edits then refresh manifests and cron discovery as usual.
    const parentCallback = getWatchCallback();
    parentCallback('rename', 'workflows');
    await vi.runAllTimersAsync();
    expect(vi.mocked(watch)).toHaveBeenCalledWith(
      '/project/.kb/workflows',
      { persistent: false },
      expect.any(Function),
    );

    getWatchCallback(1)('change', 'hello.yml');
    await vi.runAllTimersAsync();
    expect(workflowService.refreshManifests).toHaveBeenCalledTimes(1);
  });
});
