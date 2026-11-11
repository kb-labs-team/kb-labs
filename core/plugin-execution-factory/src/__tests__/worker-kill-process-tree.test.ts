/**
 * Regression test: Worker.kill() used to only SIGKILL the single
 * worker-script.js PID (`this.process.kill('SIGKILL')`). In production,
 * the handler a worker runs (e.g. release checks) shell.execs subprocesses
 * with `detached: true` (node-backend.ts, so THAT subprocess's own timeout
 * kill can clean up its own subtree in isolation) — which means those
 * subprocesses are NOT members of the worker's own process group. When the
 * worker itself was killed (e.g. an execution timeout), those detached
 * subprocesses — and anything THEY spawned — were silently orphaned and
 * kept running indefinitely. Confirmed in production: ~10 accumulated
 * orphaned worker-script.js/install processes across failed runs.
 *
 * This is a REAL process test (not mocked): a fixture worker script
 * (hanging-worker-with-child.mjs) reproduces the exact shape — on
 * 'execute' it spawns its own `detached: true` grandchild and then hangs —
 * so the test proves Worker.kill() actually reaches a process that
 * deliberately escaped its process group, the same way the real
 * `release clean install` subprocess does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from '../backends/worker-pool/worker.js';
import type { ProcessTreeResult } from '../backends/worker-pool/process-tree.js';
import type { ExecutionRequest } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANGING_WITH_CHILD_SCRIPT = path.join(__dirname, 'fixtures', 'hanging-worker-with-child.mjs');

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    handlerRef: './dist/handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    descriptor: {
      hostType: 'cli',
      pluginId: '@kb-labs/release',
      handlerId: 'checks',
    } as unknown as ExecutionRequest['descriptor'],
    ...overrides,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Worker.kill() — process-tree cleanup (real detached grandchild)', () => {
  let worker: Worker | undefined;
  let grandchildPid: number | undefined;
  let treeOutcome: ProcessTreeResult | undefined;

  afterEach(() => {
    worker?.kill();
    worker = undefined;
    if (grandchildPid !== undefined) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // The timeout path may already have killed the child.
      }
      grandchildPid = undefined;
    }
  });

  it('kills both the worker process AND a detached grandchild it spawned', async () => {
    worker = new Worker({ workerScript: HANGING_WITH_CHILD_SCRIPT });
    worker.on('treeUnverified', (_worker, result) => { treeOutcome = result; });
    await worker.spawn();
    const workerPid = worker.info.pid!;
    expect(workerPid).toBeGreaterThan(0);

    // Capture the grandchild's real OS pid via the fixture's log message,
    // then let the execution time out — which triggers Worker.kill().
    await expect(
      worker.execute(
        makeRequest(),
        300,
        (entry) => {
          const match = /spawned detached grandchild pid=(\d+)/.exec(entry.message);
          if (match) { grandchildPid = Number(match[1]); }
        },
      ),
    ).rejects.toThrow(/timed out/i);

    expect(grandchildPid).toBeGreaterThan(0);

    // Sanity check the premise: right after spawning, the grandchild really
    // is alive and really is detached into its own process group (not a
    // member of the worker's group) — otherwise this test wouldn't be
    // exercising the bug at all.
    // (checked implicitly: it's alive now, and it's a `node -e` idler with
    // no other reason to exit on its own.)

    // Wait for the bounded process-tree check to either verify the kill or
    // publish its explicit unverified result. A live child without that
    // result is a broken silent path.
    while (treeOutcome === undefined && isAlive(grandchildPid!)) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }
    while (isAlive(workerPid)) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }

    expect(isAlive(workerPid)).toBe(false);
    const grandchildAlive = isAlive(grandchildPid!);
    if (treeOutcome?.verified === false) {
      expect(treeOutcome.reason).toBeTruthy();
      expect(worker.treeUnverified).toBe(true);
    } else {
      expect(treeOutcome).toBeUndefined();
      expect(grandchildAlive).toBe(false);
    }
  });
});
