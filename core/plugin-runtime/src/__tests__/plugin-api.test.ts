/**
 * @module @kb-labs/plugin-runtime/__tests__/plugin-api
 *
 * Tests for PluginAPI modules:
 * - lifecycle (cleanup stack)
 * - output (result/meta)
 * - state (cache with tenant/plugin prefix)
 * - artifacts (file management in outdir)
 * - shell (command execution with permissions)
 * - events (noop vs real emitter)
 * - invoke (noop vs real invoker)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPluginAPI, executeCleanup } from '../api/index.js';
import type { PermissionSpec, CacheAdapter, Logger } from '@kb-labs/plugin-contracts';
import { PermissionError } from '@kb-labs/plugin-contracts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDefaultProcessExecutor } from '../process/index.js';

describe('Plugin API', () => {
  let testDir: string;
  let mockCache: CacheAdapter;
  let cleanupStack: Array<() => void | Promise<void>>;
  let processExecutor: ReturnType<typeof createDefaultProcessExecutor>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-plugin-api-test-'));

    // Mock cache adapter
    const storage = new Map<string, unknown>();
    mockCache = {
      async get<T>(key: string): Promise<T | null> {
        return (storage.get(key) as T) ?? null;
      },
      async set<T>(key: string, value: T): Promise<void> {
        storage.set(key, value);
      },
      async delete(key: string): Promise<void> {
        storage.delete(key);
      },
      async clear(): Promise<void> { storage.clear(); },
      async zadd(_key: string, _score: number, _member: string): Promise<void> {},
      async zrangebyscore(_key: string, _min: number, _max: number): Promise<string[]> { return []; },
      async zrem(_key: string, _member: string): Promise<void> {},
      async setIfNotExists<T>(_key: string, _value: T): Promise<boolean> { return false; },
    };

    // Fresh cleanup stack
    cleanupStack = [];
    processExecutor = createDefaultProcessExecutor();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('lifecycle API', () => {
    it('should register cleanup functions', () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      const cleanup1 = vi.fn();
      const cleanup2 = vi.fn();

      api.lifecycle.onCleanup(cleanup1);
      api.lifecycle.onCleanup(cleanup2);

      expect(cleanupStack).toHaveLength(2);
      expect(cleanupStack[0]).toBe(cleanup1);
      expect(cleanupStack[1]).toBe(cleanup2);
    });

    it('should execute cleanups in LIFO order', async () => {
      const order: number[] = [];
      const cleanup1 = async () => { order.push(1); };
      const cleanup2 = async () => { order.push(2); };
      const cleanup3 = async () => { order.push(3); };

      cleanupStack.push(cleanup1, cleanup2, cleanup3);

      const mockLogger: Logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        child: vi.fn(() => mockLogger),
      };

      await executeCleanup(cleanupStack, mockLogger);

      // LIFO: 3, 2, 1
      expect(order).toEqual([3, 2, 1]);
    });

    it('should continue cleanup on errors', async () => {
      const cleanup1 = vi.fn().mockResolvedValue(undefined);
      const cleanup2 = vi.fn().mockRejectedValue(new Error('cleanup2 failed'));
      const cleanup3 = vi.fn().mockResolvedValue(undefined);

      cleanupStack.push(cleanup1, cleanup2, cleanup3);

      const mockLogger: Logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        child: vi.fn(() => mockLogger),
      };

      await executeCleanup(cleanupStack, mockLogger);

      // All should be called despite error
      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
      expect(cleanup3).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith('Cleanup failed', expect.any(Object));
    });
  });

  // OutputAPI removed - use return values instead (V3 migration)
  // ctx.api.output is represented by the canonical command result.

  describe('state API', () => {
    it('should prefix keys with tenant:plugin', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/my-plugin',
        tenantId: 'acme-corp',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      await api.state.set('user-setting', { theme: 'dark' });

      // Check that cache has prefixed key
      const cached = await mockCache.get('acme-corp:@kb-labs/my-plugin:user-setting');
      expect(cached).toEqual({ theme: 'dark' });
    });

    it('should use "default" tenant when tenantId not provided', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/my-plugin',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      await api.state.set('key', 'value');

      const cached = await mockCache.get('default:@kb-labs/my-plugin:key');
      expect(cached).toBe('value');
    });

    it('should get, set, delete, has', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      // Set
      await api.state.set('test-key', { data: 'value' });

      // Get
      const value = await api.state.get<{ data: string }>('test-key');
      expect(value).toEqual({ data: 'value' });

      // Has
      const exists = await api.state.has('test-key');
      expect(exists).toBe(true);

      // Delete
      await api.state.delete('test-key');

      // Has (after delete)
      const existsAfterDelete = await api.state.has('test-key');
      expect(existsAfterDelete).toBe(false);
    });

    it('should support getMany and setMany', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
      });

      // setMany with Map
      const entries = new Map([
        ['key1', 'value1'],
        ['key2', 'value2'],
        ['key3', 'value3'],
      ]);
      await api.state.setMany(entries);

      // getMany
      const values = await api.state.getMany(['key1', 'key2', 'key3', 'key4']);
      expect(values.get('key1')).toBe('value1');
      expect(values.get('key2')).toBe('value2');
      expect(values.get('key3')).toBe('value3');
      expect(values.has('key4')).toBe(false); // Doesn't exist
    });

    it('should support setMany with object', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      await api.state.setMany({ a: 1, b: 2, c: 3 });

      const a = await api.state.get<number>('a');
      expect(a).toBe(1);
    });
  });

  describe('artifacts API', () => {
    it('should write artifact to outdir', async () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      const filePath = await api.artifacts.write('result.json', JSON.stringify({ data: 'test' }));

      expect(filePath).toBe(path.join(outdir, 'result.json'));

      const content = await fs.readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual({ data: 'test' });
    });

    it('should support nested artifact paths', async () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      const filePath = await api.artifacts.write('subdir/nested/file.txt', 'nested content');

      expect(filePath).toBe(path.join(outdir, 'subdir/nested/file.txt'));

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('nested content');
    });

    it('should list artifacts', async () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      await api.artifacts.write('file1.txt', 'content1');
      await api.artifacts.write('file2.txt', 'content2');

      const artifacts = await api.artifacts.list();

      expect(artifacts).toHaveLength(2);
      expect(artifacts.find(a => a.name === 'file1.txt')).toBeDefined();
      expect(artifacts.find(a => a.name === 'file2.txt')).toBeDefined();
    });

    it('should read artifact', async () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
      });

      await api.artifacts.write('data.txt', 'file content');

      const content = await api.artifacts.read('data.txt');
      expect(content).toBe('file content');
    });

    it('should read artifact as buffer', async () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
      });

      const binaryData = new Uint8Array([0x01, 0x02, 0x03]);
      await api.artifacts.write('binary.bin', binaryData);

      const buffer = await api.artifacts.readBuffer('binary.bin');
      expect(buffer).toEqual(binaryData);
    });

    it('should check artifact existence', async () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
      });

      await api.artifacts.write('exists.txt', 'content');

      const exists = await api.artifacts.exists('exists.txt');
      expect(exists).toBe(true);

      const notExists = await api.artifacts.exists('not-exists.txt');
      expect(notExists).toBe(false);
    });

    it('should return artifact path', () => {
      const outdir = path.join(testDir, 'output');
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir,
        permissions,
        cache: mockCache,
        cleanupStack,
      });

      const artifactPath = api.artifacts.path('report.pdf');
      expect(artifactPath).toBe(path.join(outdir, 'report.pdf'));
    });
  });

  describe('shell API', () => {
    // case: S-295.2
    it('denies undeclared shell commands with the typed permission code', async () => {
      const permissions: PermissionSpec = {
        // No shell permission
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      const execute = vi.spyOn(processExecutor, 'execute');
      await expect(api.shell.exec('echo', ['hello'])).rejects.toMatchObject({ code: 'KB_PLUGIN_PERMISSION_DENIED' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('should allow whitelisted commands', async () => {
      const permissions: PermissionSpec = {
        shell: {
          allow: ['echo', 'ls'],
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      const result = await api.shell.exec('echo', ['hello world']);

      expect(result.ok).toBe(true);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
    });

    it('should block non-whitelisted commands', async () => {
      const permissions: PermissionSpec = {
        shell: {
          allow: ['echo'],
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      await expect(
        api.shell.exec('ls', [])
      ).rejects.toThrow(PermissionError);
    });

    it('should block dangerous commands', async () => {
      const permissions: PermissionSpec = {
        shell: {
          allow: ['*'], // Allow all (risky, but for testing)
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      await expect(
        api.shell.exec('rm', ['-rf', '/'])
      ).rejects.toThrow(PermissionError);
    });

    it('should allow all commands when whitelist is empty', async () => {
      const permissions: PermissionSpec = {
        shell: {
          allow: ['*'], // '*' = allow all (except BLOCKED_COMMANDS)
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        processExecutor,
      });

      const result = await api.shell.exec('echo', ['test']);
      expect(result.ok).toBe(true);
    });
  });

  describe('events API', () => {
    it('should use noop implementation when no emitter provided', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        // No eventEmitter provided
      });

      // Should not throw, just noop
      await expect(
        api.events.emit('test-event', { data: 'value' })
      ).resolves.not.toThrow();
    });

    it('should call provided emitter with prefixed event', async () => {
      const mockEmitter = vi.fn().mockResolvedValue(undefined);
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        eventEmitter: mockEmitter,
      });

      await api.events.emit('custom-event', { foo: 'bar' });

      // Emitter receives prefixed event: "pluginId:event"
      expect(mockEmitter).toHaveBeenCalledWith(
        '@kb-labs/test:custom-event',
        { foo: 'bar' }
      );
    });
  });

  describe('invoke API', () => {
    it('should use noop implementation when no invoker provided', async () => {
      const permissions: PermissionSpec = {};
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        // No pluginInvoker provided
      });

      // Noop invoker throws PermissionError
      await expect(
        api.invoke.call('@kb-labs/other-plugin', { input: 'test' })
      ).rejects.toThrow(PermissionError);
    });

    // case: S-295.1
    it('denies undeclared invoke calls with the typed permission code', async () => {
      const mockInvoker = vi.fn().mockResolvedValue({ result: 'success' });

      const permissions: PermissionSpec = {
        // No invoke permission
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        pluginInvoker: mockInvoker,
      });

      await expect(api.invoke.call('@kb-labs/other-plugin', { input: 'data' })).rejects.toMatchObject({ code: 'KB_PLUGIN_PERMISSION_DENIED' });

      // Invoker should not be called
      expect(mockInvoker).not.toHaveBeenCalled();
    });

    it('should call provided invoker when permission granted', async () => {
      const mockInvoker = vi.fn().mockResolvedValue({
        ok: true,
        result: { output: 'success' },
      });

      const permissions: PermissionSpec = {
        invoke: {
          allow: ['*'], // '*' = allow all
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        pluginInvoker: mockInvoker,
      });

      const result = await api.invoke.call('@kb-labs/other-plugin', { input: 'data' });

      expect(result).toEqual({
        ok: true,
        result: { output: 'success' },
      });

      expect(mockInvoker).toHaveBeenCalledWith(
        '@kb-labs/other-plugin',
        { input: 'data' },
        undefined
      );
    });

    it('should check plugin whitelist', async () => {
      const mockInvoker = vi.fn().mockResolvedValue({ result: 'success' });

      const permissions: PermissionSpec = {
        invoke: {
          allow: ['@kb-labs/allowed-plugin'],
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        pluginInvoker: mockInvoker,
      });

      // Allowed plugin should work
      await api.invoke.call('@kb-labs/allowed-plugin', { data: 'test' });
      expect(mockInvoker).toHaveBeenCalled();

      // Non-allowed plugin should fail
      await expect(
        api.invoke.call('@kb-labs/forbidden-plugin', { data: 'test' })
      ).rejects.toThrow(PermissionError);
    });

    it('should deny targeted invoke when execution target permission is missing', async () => {
      const mockInvoker = vi.fn().mockResolvedValue({ result: 'success' });

      const permissions: PermissionSpec = {
        invoke: {
          allow: ['*'],
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        pluginInvoker: mockInvoker,
      });

      await expect(
        api.invoke.call('@kb-labs/allowed-plugin', { ping: true }, {
          target: { environmentId: 'env-1', namespace: 'demo/local' },
        })
      ).rejects.toThrow(PermissionError);
    });

    it('should allow targeted invoke when execution target scope is granted', async () => {
      const mockInvoker = vi.fn().mockResolvedValue({ result: 'success' });

      const permissions: PermissionSpec = {
        invoke: {
          allow: ['*'],
        },
        platform: {
          execution: {
            targetUse: true,
            namespaces: ['demo/*'],
          },
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        pluginInvoker: mockInvoker,
      });

      await api.invoke.call('@kb-labs/allowed-plugin', { ping: true }, {
        target: { environmentId: 'env-1', namespace: 'demo/local' },
      });

      expect(mockInvoker).toHaveBeenCalledWith(
        '@kb-labs/allowed-plugin',
        { ping: true },
        { target: { environmentId: 'env-1', namespace: 'demo/local' } }
      );
    });

    it('should emit target execution audit event for targeted invoke', async () => {
      const mockInvoker = vi.fn().mockResolvedValue({ result: 'success' });
      const track = vi.fn(async () => undefined);
      const publish = vi.fn(async () => undefined);

      const permissions: PermissionSpec = {
        invoke: {
          allow: ['*'],
        },
        platform: {
          execution: {
            targetUse: true,
            namespaces: ['demo/*'],
          },
        },
      };
      const api = createPluginAPI({
        pluginId: '@kb-labs/test',
        handlerId: 'invoke-handler',
        tenantId: 'tenant-a',
        cwd: testDir,
        outdir: path.join(testDir, 'output'),
        permissions,
        cache: mockCache,
        cleanupStack,
        pluginInvoker: mockInvoker,
        analytics: { track },
        eventBus: { publish },
      });

      await api.invoke.call('@kb-labs/allowed-plugin', { ping: true }, {
        target: { environmentId: 'env-1', namespace: 'demo/local' },
      });

      expect(track).toHaveBeenCalledWith(
        'plugin.target_execution.requested',
        expect.objectContaining({
          method: 'invoke',
          sourcePluginId: '@kb-labs/test',
          sourceHandlerId: 'invoke-handler',
          tenantId: 'tenant-a',
          targetPluginId: '@kb-labs/allowed-plugin',
          target: {
            environmentId: 'env-1',
            namespace: 'demo/local',
          },
        })
      );
      expect(publish).toHaveBeenCalledWith(
        'plugin.target-execution.requested',
        expect.objectContaining({
          method: 'invoke',
          sourcePluginId: '@kb-labs/test',
          sourceHandlerId: 'invoke-handler',
          tenantId: 'tenant-a',
          targetPluginId: '@kb-labs/allowed-plugin',
        })
      );
    });
  });
});
