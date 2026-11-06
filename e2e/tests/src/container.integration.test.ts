import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DockerEnvironmentAdapter } from '@kb-labs/adapters-environment-docker';

const dockerImage = process.env.KB_CONTAINER_TEST_IMAGE ?? 'node:20-alpine';
const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const dockerInfo = spawnSync('docker', ['info'], { encoding: 'utf8' });
const dockerImageCheck = dockerInfo.status === 0
  ? spawnSync('docker', ['image', 'inspect', dockerImage], { encoding: 'utf8' })
  : undefined;
const dockerAvailable = dockerInfo.status === 0 && dockerImageCheck?.status === 0;
const dockerSkipReason = dockerInfo.error?.message || dockerInfo.stderr?.trim() || dockerImageCheck?.stderr?.trim() || 'Docker is unavailable';
if (!dockerAvailable) {
  console.info(`[SKIP] Docker execution policy integration: ${dockerSkipReason}`);
}

const owners: Array<{ adapter: DockerEnvironmentAdapter; environmentId: string }> = [];
const runIds = new Set<string>();
const cleanupFailures: Error[] = [];

function reserveOwner(runId: string, runtimeCommand: string[]): Promise<{ adapter: DockerEnvironmentAdapter; environmentId: string }> {
  const adapter = new DockerEnvironmentAdapter({ defaultImage: dockerImage, runtimeCommand });
  runIds.add(runId);
  return adapter.reserve({ runId }).then(({ environmentId }) => {
    const owner = { adapter, environmentId };
    owners.push(owner);
    return owner;
  });
}

async function cleanupOwners(): Promise<void> {
  for (const owner of [...owners]) {
    try {
      await owner.adapter.destroy(owner.environmentId);
      const ownerIndex = owners.indexOf(owner);
      if (ownerIndex >= 0) { owners.splice(ownerIndex, 1); }
    } catch (error) {
      cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function waitForRunContainersRemoval(runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = '';
  while (Date.now() < deadline) {
    remaining = execFileSync('docker', ['ps', '-a', '-q', '--filter', `label=kb.run_id=${runId}`], { encoding: 'utf8' }).trim();
    if (remaining === '') { return; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Docker containers remain for run ${runId}: ${remaining}`);
}

describe('Docker execution policy integration', () => {
  // Owner teardown uses stdin EOF and daemon-side removal; keep cleanup failures bounded.
  afterEach(cleanupOwners, 10_000);

  // Docker label inspection is bounded separately from the per-test startup allowance.
  afterAll(async () => {
    if (!dockerAvailable) { return; }
    await cleanupOwners();
    for (const runId of runIds) {
      const remaining = execFileSync('docker', ['ps', '-a', '-q', '--filter', `label=kb.run_id=${runId}`], { encoding: 'utf8' }).trim();
      expect(remaining, `containers remain for kb.run_id=${runId}`).toBe('');
    }
    expect(cleanupFailures).toEqual([]);
  }, 30_000);

  // Image startup and Docker daemon inspection can take longer than Vitest's default 5 seconds.
  // case: S-244.1
  it('provisions only permission mounts and declared environment with Docker networking disabled', async ({ skip }) => {
    if (!dockerAvailable) skip(`Docker is unavailable: ${dockerSkipReason}`);
    const runId = `policy-${process.pid}-${Date.now()}`;
    const { adapter, environmentId } = await reserveOwner(runId, [
      'node', '-e', "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ]);
    const started = await adapter.start(environmentId, {
      workspacePath: repositoryRoot,
      executionPolicy: {
        mounts: [{ path: '.', access: 'read-only' }],
        environment: { KB_CONTAINER_PUBLIC: 'visible' },
      },
    });

    const containerId = started.metadata?.containerId;
    expect(containerId).toBeTruthy();
    const inspected = JSON.parse(execFileSync('docker', ['inspect', String(containerId)], { encoding: 'utf8' }))[0] as {
      HostConfig: { NetworkMode: string; AutoRemove: boolean };
      Config: { OpenStdin: boolean; Env: string[] };
      Mounts: Array<{ Destination: string; RW: boolean }>;
      State: { Running: boolean };
    };
    expect(inspected.State.Running).toBe(true);
    expect(inspected.Config.OpenStdin).toBe(true);
    expect(inspected.HostConfig.AutoRemove).toBe(true);
    expect(inspected.HostConfig.NetworkMode).toBe('none');
    expect(inspected.Mounts.map(({ Destination, RW }) => ({ Destination, RW }))).toEqual([
      { Destination: '/workspace', RW: false },
    ]);
    expect(inspected.Config.Env).toContain('KB_CONTAINER_PUBLIC=visible');
    expect(inspected.Config.Env).not.toContain('KB_CONTAINER_UNDECLARED=hidden');
    expect(inspected.Config.Env).not.toContain('KB_CONTAINER_EXECUTION=1');
    expect(inspected.Config.Env.some((entry) => entry.startsWith('GATEWAY_WS_URL='))).toBe(false);

    const teardownStartedAt = Date.now();
    await adapter.destroy(environmentId);
    await waitForRunContainersRemoval(runId, 5_000);
    expect(Date.now() - teardownStartedAt).toBeLessThan(5_000);
    const ownerIndex = owners.findIndex((owner) => owner.adapter === adapter && owner.environmentId === environmentId);
    if (ownerIndex >= 0) { owners.splice(ownerIndex, 1); }
  }, 120_000);

  // The image is already available; bound namespace setup plus the two-second TCP probe.
  // case: S-244.3
  it('blocks a raw outbound TCP socket in the container network namespace', async ({ skip }) => {
    if (!dockerAvailable) skip(`Docker is unavailable: ${dockerSkipReason}`);
    const runtimeCommand = [
      'node',
      '-e',
      "process.stdout.write('probe-started\\n'); const socket = require('node:net').connect(443, '1.1.1.1'); socket.on('connect', () => process.exit(0)); socket.on('error', () => process.exit(23)); socket.setTimeout(2000, () => process.exit(23));",
    ];
    const runId = `network-none-${process.pid}-${Date.now()}`;
    const { adapter, environmentId } = await reserveOwner(runId, runtimeCommand);
    const started = await adapter.start(environmentId, {
      workspacePath: repositoryRoot,
      executionPolicy: { mounts: [], environment: {} },
    });
    await expect(adapter.getExecutionStream(environmentId).completion).resolves.toEqual({ code: 23, signal: null });
    expect(spawnSync('docker', ['inspect', String(started.metadata?.containerId)], { encoding: 'utf8' }).status).not.toBe(0);
  }, 30_000);

  // A host process crash closes its Docker client's stdin; bootstrap EOF handling must remove the attached container.
  // case: S-244.10
  it('exits and removes the container when the host-side client process dies', async ({ skip }) => {
    if (!dockerAvailable) skip(`Docker is unavailable: ${dockerSkipReason}`);
    const runId = `host-death-${process.pid}-${Date.now()}`;
    runIds.add(runId);
    const client = spawn(process.execPath, [resolve(testDirectory, '../fixtures/container-host-client.mjs')], {
      cwd: repositoryRoot,
      env: { ...process.env, KB_CONTAINER_TEST_IMAGE: dockerImage, KB_CONTAINER_TEST_RUN_ID: runId, KB_CONTAINER_TEST_WORKSPACE: repositoryRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    client.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    client.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    try {
      const { line } = await new Promise<{ line: string }>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error(`Host client did not provision a container: ${Buffer.concat(errors).toString('utf8')}`)), 25_000);
        client.stdout.on('data', () => {
          const text = Buffer.concat(output).toString('utf8');
          const newline = text.indexOf('\n');
          if (newline >= 0) {
            clearTimeout(timeout);
            const line = text.slice(0, newline);
            resolveReady({ line });
          }
        });
        client.once('error', (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        client.once('exit', (code) => {
          clearTimeout(timeout);
          rejectReady(new Error(`Host client exited before readiness (code ${code}): ${Buffer.concat(errors).toString('utf8')}`));
        });
      });
      expect(line).toContain(runId);
      client.kill('SIGKILL');
      await once(client, 'exit');
      await waitForRunContainersRemoval(runId, 10_000);
    } finally {
      if (client.exitCode === null && client.signalCode === null) {
        if (client.pid !== undefined) {
          client.kill('SIGKILL');
          if (client.exitCode === null && client.signalCode === null) {
            await new Promise<void>((resolveExit) => client.once('exit', () => resolveExit()));
          }
        }
      }
      const remaining = spawnSync('docker', ['ps', '-a', '-q', '--filter', `label=kb.run_id=${runId}`], { encoding: 'utf8' });
      if (remaining.status !== 0) {
        cleanupFailures.push(new Error(`Could not list containers for run ${runId}: ${remaining.stderr.trim()}`));
      } else {
        const teardownOwner = new DockerEnvironmentAdapter({ defaultImage: dockerImage });
        for (const containerId of remaining.stdout.trim().split('\n').filter(Boolean)) {
          owners.push({ adapter: teardownOwner, environmentId: containerId });
        }
      }
    }
  }, 30_000);
});
