import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import { createStdioChannel, StdioPlatformServer } from '@kb-labs/core-ipc';
import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';

const image = process.env.KB_CONTAINER_TEST_IMAGE ?? 'node:20-alpine';
const dockerInfo = spawnSync('docker', ['info'], { encoding: 'utf8' });
const imageInfo = dockerInfo.status === 0
  ? spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' })
  : undefined;
const dockerAvailable = dockerInfo.status === 0 && imageInfo?.status === 0;
const dockerSkipReason = dockerInfo.error?.message ?? dockerInfo.stderr?.trim() ?? imageInfo?.stderr?.trim() ?? 'Docker or test image is unavailable';

function platform(): IPlatformAdapters {
  const logger = {
    debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, child() { return this; },
  };
  return {
    logger,
    cache: { get: async (key: string) => `host:${key}`, set: async () => {}, delete: async () => {}, clear: async () => {} },
  } as unknown as IPlatformAdapters;
}

describe('container stdio dispatch integration', () => {
  // case: S-244.8
  it('dispatches a plugin over the attached no-network container stream and removes the container', async ({ skip }) => {
    if (!dockerAvailable) {skip(`Docker is unavailable: ${dockerSkipReason}`);}
    const repositoryRoot = resolve(process.cwd(), '../..');
    const name = `kb-stdio-${process.pid}-${Date.now()}`;
    const bootstrapPath = '/workspace/core/plugin-runtime/dist/sandbox/bootstrap.js';
    const handlerPath = '/workspace/core/plugin-runtime/src/__tests__/fixtures/container-stdio-handler.mjs';
    const child: ChildProcessWithoutNullStreams = spawn('docker', [
      'run', '-i', '--rm', '--network', 'none', '--name', name,
      '--mount', `type=bind,source=${repositoryRoot},target=/workspace,readonly`,
      image, 'node', bootstrapPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const channel = createStdioChannel(child.stdout, child.stdin);
    const rpcServer = new StdioPlatformServer(channel, platform());
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli', pluginId: '@kb-labs/test-container-stdio', pluginVersion: '1.0.0',
      requestId: name, handlerId: 'test:container-stdio', permissions: { platform: { cache: true } },
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    };
    const logs: string[] = [];
    const unsubscribeLog = channel.on('log', (frame) => logs.push(frame.message));
    const result = new Promise<unknown>((resolveResult, rejectResult) => {
      channel.on('execution:result', (frame) => resolveResult(frame.payload));
      channel.on('execution:error', (frame) => rejectResult(new Error(JSON.stringify(frame.payload))));
      channel.onError(rejectResult);
      channel.onClose(() => rejectResult(new Error('Container control stream closed before result')));
    });
    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once('spawn', () => resolveSpawn());
        child.once('error', rejectSpawn);
      });
      await channel.send({
        type: 'execution:start',
        requestId: name,
        payload: { requestId: name, descriptor, handlerPath, input: {}, cwd: '/workspace', strictFilesystemPermissions: true, outdir: '/workspace/.kb/output' },
      });
      await expect(result).resolves.toBe('host:container-stdio-key');
      expect(logs.join('')).toContain('container-stdio-handler-log');
      child.stdin.end();
      await once(child, 'exit');
      expect(spawnSync('docker', ['inspect', name], { encoding: 'utf8' }).status).not.toBe(0);
    } finally {
      unsubscribeLog();
      rpcServer.close();
      channel.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit').catch(() => undefined);
      }
      spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
    }
  }, 30000);
});
