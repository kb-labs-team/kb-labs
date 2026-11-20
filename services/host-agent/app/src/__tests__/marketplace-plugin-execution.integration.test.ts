import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveProjectId } from '@kb-labs/core-project-registry';
import { createEmptyLock, createMarketplaceEntry, writeMarketplaceLock } from '@kb-labs/core-discovery';
import { createExtensionStore } from '@kb-labs/core-extension-store';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';
import { ExecutionHandler } from '../handlers/execution-handler.js';

describe('Marketplace plugin execution on the configured Host Agent', () => {
  let root: string | undefined;
  const previousKbHome = process.env.KB_HOME;

  afterEach(async () => {
    if (root) { await rm(root, { recursive: true, force: true }); }
    root = undefined;
    if (previousKbHome === undefined) { delete process.env.KB_HOME; }
    else { process.env.KB_HOME = previousKbHome; }
  });

  it('executes the project pin from the exact extension-store version and manifest handler', async () => {
    // case: S-010.8
    root = await mkdtemp(path.join(tmpdir(), 'kb-host-marketplace-execution-'));
    const kbHome = path.join(root, 'home', '.kb');
    const projectRoot = path.join(root, 'project');
    const pluginId = '@journey/registry-canonical';
    const version = '1.0.2';
    const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
    const manifest = {
      schema: 'kb.plugin/3',
      id: pluginId,
      version,
      permissions: { fs: { read: ['.'], write: [] } },
      cli: { commands: [{ path: 'journey-smoke run', describe: 'Run fixture', handler: './dist/handler.js#execute' }] },
    };

    await mkdir(projectRoot, { recursive: true });
    const store = createExtensionStore({
      root: kbHome,
      installer: {
        async install({ name, version: packageVersion, projectDir }) {
          const packageRoot = path.join(projectDir, 'node_modules', ...name.split('/'));
          await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
          await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: packageVersion }));
          await writeFile(path.join(packageRoot, 'dist', 'manifest.json'), JSON.stringify(manifest));
          await writeFile(path.join(packageRoot, 'dist', 'handler.js'), [
            'export async function execute(context, input) {',
            '  return { pluginId: context.pluginId, pluginVersion: context.pluginVersion, cwd: context.cwd, permissions: context.permissions, input };',
            '}',
          ].join('\n'));
          return { integrity, packageRoot };
        },
      },
    });
    await store.resolve({ name: pluginId, version, kind: 'plugin', spec: 'file:fixture', expectedIntegrity: integrity });

    const lock = createEmptyLock();
    lock.plugins[pluginId] = createMarketplaceEntry({
      version,
      integrity,
      source: 'marketplace',
      package: pluginId,
      primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
      marketplaceSource: 'npm',
      signatureStatus: 'unsigned',
    });
    await writeMarketplaceLock(projectRoot, lock, 'project');

    process.env.KB_HOME = kbHome;
    const handler = new ExecutionHandler({
      gatewayTransport: { send: async () => ({ ok: true }), close: async () => {} } as never,
      allowedPaths: [projectRoot],
      allowedPlugins: [pluginId],
      marketplacePins: [{ package: pluginId, version, integrity }],
      namespaceId: 'test-namespace',
      executionMode: 'in-process',
      timeoutMs: 5_000,
    });

    try {
      const executeCall = (executionId: string) => ({
        type: 'call',
        requestId: 'gateway-request-1',
        adapter: 'execution',
        method: 'execute',
        args: [{
          executionId,
          requestId: 'gateway-request-1',
          projectId: deriveProjectId(projectRoot),
          namespaceId: 'test-namespace',
          pluginId,
          commandPath: 'journey-smoke run',
          input: { argv: [], flags: { json: true } },
          descriptor: { permissions: { fs: { write: ['.'] } } },
          handlerRef: '/tmp/untrusted-handler.js',
        }],
      } satisfies CapabilityCall);
      const result = await handler.handle(executeCall('gateway-execution-1'));

      expect(result).toEqual({
        pluginId,
        pluginVersion: version,
        cwd: projectRoot,
        permissions: { fs: { read: ['.'], write: [] } },
        input: { argv: [], flags: { json: true } },
      });

      for (const [index, approved] of [
        { package: pluginId, version: '9.9.9', integrity },
        { package: pluginId, version, integrity: 'sha512-wrong' },
      ].entries()) {
        const wrongPin = new ExecutionHandler({
          gatewayTransport: { send: async () => ({ ok: true }), close: async () => {} } as never,
          allowedPaths: [projectRoot],
          allowedPlugins: [pluginId],
          marketplacePins: [approved],
          namespaceId: 'test-namespace',
          executionMode: 'in-process',
          timeoutMs: 5_000,
        });
        try {
          await expect(wrongPin.handle(executeCall(`gateway-execution-wrong-pin-${index}`)))
            .rejects.toThrow(/pin is not approved by Host Agent policy/);
        } finally {
          wrongPin.stop();
        }
      }
    } finally {
      handler.stop();
    }
  });
});
