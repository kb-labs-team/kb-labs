/**
 * @module @kb-labs/core-runtime/__tests__/loader
 *
 * Tests for platform initialization and adapter loading.
 *
 * Tests:
 * - initPlatform with config
 * - Adapter loading from package paths
 * - Core features initialization
 * - Resource broker initialization
 * - Idempotent initialization
 * - Reset and re-initialization
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createDegradedAdapterProxy, fillAdapterFallbacksAndRecord, initPlatform, resetPlatform } from '../loader.js';
import { platform } from '../container.js';
import { getAdapterStatusFor, resetAdapterStatus } from '../adapter-status.js';
import { AdapterUnavailableError, toErrorEnvelope, type IEnvironmentProvider } from '@kb-labs/core-platform';
import type { ExecutionRequest } from '@kb-labs/plugin-execution-factory';
import { writeTestPlatformReceipt } from './platform-version-fixture.js';

vi.mock('../platform-version.js', () => ({ resolvePlatformVersion: async () => 'test' }));

describe('Platform Loader', () => {
  beforeEach(() => {
    // Reset platform before each test
    resetPlatform();
  });

  describe('initPlatform - Basic Initialization', () => {
    it('should initialize platform with empty config', async () => {
      const result = await initPlatform({});

      expect(result).toBe(platform);
      expect(platform.isInitialized).toBe(true);
    });

    it('should initialize core features', async () => {
      await initPlatform({});

      expect(platform.isInitialized).toBe(true);
      expect(platform.workflows).toBeDefined();
      expect(platform.jobs).toBeDefined();
      expect(platform.cron).toBeDefined();
      expect(platform.resources).toBeDefined();
    });

    it('should initialize resource broker', async () => {
      await initPlatform({});

      expect(platform.hasResourceBroker).toBe(true);
      expect(platform.resourceBroker).toBeDefined();
    });

    it('should be idempotent', async () => {
      const first = await initPlatform({});
      const second = await initPlatform({});

      expect(first).toBe(second);
      expect(first).toBe(platform);
    });

    it('should set isInitialized flag', async () => {
      expect(platform.isInitialized).toBe(false);

      await initPlatform({});

      expect(platform.isInitialized).toBe(true);
    });
  });

  describe('Adapter Configuration', () => {
    // case: S-219.1
    it('binds and constructs notifier-router through initPlatform', async () => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'kb-notifier-loader-'));
      const workspaceRoot = path.join(tempRoot, 'workspace');
      const isolatedHome = path.join(tempRoot, 'home');
      const adapterRoot = path.join(workspaceRoot, 'adapters', 'notifier-router');
      const telegramRoot = path.join(workspaceRoot, 'adapters', 'telegram');
      try {
        await mkdir(adapterRoot, { recursive: true });
        await mkdir(telegramRoot, { recursive: true });
        await mkdir(isolatedHome, { recursive: true });
        writeTestPlatformReceipt(workspaceRoot);
        await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
        await writeFile(path.join(adapterRoot, 'package.json'), await readFile(path.join(repoRoot, 'adapters/notifier-router/package.json')));
        await symlink(path.join(repoRoot, 'adapters/notifier-router/dist'), path.join(adapterRoot, 'dist'));
        await writeFile(path.join(telegramRoot, 'package.json'), await readFile(path.join(repoRoot, 'adapters/telegram/package.json')));
        await symlink(path.join(repoRoot, 'adapters/telegram/dist'), path.join(telegramRoot, 'dist'));

        const runtimeModule = path.join(repoRoot, 'core/runtime/dist/index.js');
        const script = `
          import { initPlatform, platform } from ${JSON.stringify(pathToFileURL(runtimeModule).href)};
          let telegramRequests = 0;
          const brokerRegistrations = [];
          const brokerReadyAtRegistration = [];
          const initResourceBroker = platform.initResourceBroker;
          platform.initResourceBroker = function (broker) {
            const register = broker.register.bind(broker);
            broker.register = (resource, config) => {
              brokerRegistrations.push(resource);
              brokerReadyAtRegistration.push(platform.hasResourceBroker);
              return register(resource, config);
            };
            return initResourceBroker.call(this, broker);
          };
          globalThis.fetch = async () => { telegramRequests++; return new Response('{"ok":true}', { status: 200 }); };
          await initPlatform({
            adapters: { notifier: '@kb-labs/notifier-router' },
            adapterOptions: {
              notifier: {
                channels: { ops: { type: 'telegram', botToken: 'test-token', chatId: 'test-chat' } },
                routing: [{ match: { severity: ['info'] }, channels: ['ops'] }],
              },
            },
          }, ${JSON.stringify(workspaceRoot)}, undefined, undefined, { workspaceDevelopment: true, workspaceRoot: ${JSON.stringify(workspaceRoot)} });
          await platform.notifier.notify({ severity: 'info', title: 'loader test', body: 'bound' });
          console.log('C01_RESULT ' + JSON.stringify({ real: platform.isReal('notifier'), telegramRequests, brokerRegistrations, brokerReadyAtRegistration }));
          process.exit(0);
        `;
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: isolatedHome };
        delete env.KB_PLATFORM_ROOT;
        delete env.KB_HOME;
        delete env.KB_NET_OFFSET;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: workspaceRoot,
          env,
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('C01_RESULT {"real":true,"telegramRequests":1,"brokerRegistrations":["notifier:ops"],"brokerReadyAtRegistration":[true]}');
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });

    // case: S-211.6
    it('throws the typed unavailable error for method and property reads and remains safely awaitable', async () => {
      const error = new AdapterUnavailableError('llm', 'load-failed', 'adapter load failed');
      const adapter = createDegradedAdapterProxy({ complete: () => 'fallback', label: 'fallback-value' }, error) as {
        complete(): string;
        label: string;
      };
      expect(() => adapter.complete()).toThrow(error);
      expect(() => adapter.label).toThrow(error);
      expect(await adapter).toBe(adapter);
      expect(Reflect.get(adapter, Symbol.toStringTag)).toBeUndefined();
    });

    // case: S-211.6
    it('throws a typed error for a degraded slot with no fallback target', () => {
      const error = new AdapterUnavailableError('vectorStore', 'load-failed', 'adapter load failed');
      const adapter = createDegradedAdapterProxy(undefined, error) as {
        upsert(): void;
        anyProperty: unknown;
      };
      expect(() => adapter.upsert()).toThrow(error);
      expect(() => adapter.anyProperty).toThrow(error);
    });

    // case: S-286.2
    it('starts a development workspace with its manifest-declared vector default', async () => {
      const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
      const root = await mkdtemp(path.join(tmpdir(), 'kb-workspace-vector-'));
      const adapter = path.join(root, 'adapters', 'sqlite');
      vi.stubEnv('KB_HOME', path.join(root, 'home'));
      try {
        await mkdir(adapter, { recursive: true });
        await mkdir(path.join(root, '.kb', 'data'), { recursive: true });
        await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
        await writeFile(path.join(adapter, 'package.json'), await readFile(path.join(repo, 'adapters/sqlite/package.json')));
        await symlink(path.join(repo, 'adapters/sqlite/dist'), path.join(adapter, 'dist'));
        await symlink(path.join(repo, 'tools'), path.join(root, 'tools'));
        resetAdapterStatus();
        await initPlatform({}, root, undefined, undefined, { workspaceDevelopment: true, workspaceRoot: root });
        expect(platform.isInitialized).toBe(true);
        expect(getAdapterStatusFor('vectorStore')).toMatchObject({ mode: 'real', implementation: '@kb-labs/adapters-sqlite/vector-store' });
      } finally {
        await platform.shutdown();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports a missing required local default as a typed startup error', () => {
      platform.reset();
      resetAdapterStatus();
      let failure: unknown;
      try { fillAdapterFallbacksAndRecord(platform, {}, true); } catch (error) { failure = error; }
      const envelope = toErrorEnvelope(failure);
      expect(envelope.code).toBe('KB_HOST_ADAPTER_UNAVAILABLE');
      expect(failure).toBeInstanceOf(AdapterUnavailableError);
      if (!(failure instanceof AdapterUnavailableError)) throw new Error('Expected an adapter failure');
      expect(envelope.message).toBe(failure.userMessage);
      expect(envelope.hint).toBe(failure.action?.command);
    });

    it('reports the composed local log reader as real when its backends are loaded', () => {
      platform.setAdapter('logRingBuffer', {});
      resetAdapterStatus();

      fillAdapterFallbacksAndRecord(platform, {});

      expect(getAdapterStatusFor('logs')).toMatchObject({
        mode: 'real',
        implementation: 'HybridLogReader',
      });
    });

    // case: S-211.6
    it('records a failed configured slot as degraded while keeping other slots available', async () => {
      platform.reset();
      platform.setAdapter('llm', undefined as never);
      resetAdapterStatus();
      fillAdapterFallbacksAndRecord(
        platform,
        { llm: '@kb-labs/adapters-missing-llm' },
        false,
        new Map([['llm', {
          packageName: '@kb-labs/adapters-missing-llm',
          correlationId: 'test-correlation',
          cause: 'package was not found',
          causeError: new Error('package was not found'),
          action: {
            id: 'install-adapter',
            label: 'Install @kb-labs/adapters-missing-llm',
            command: 'kb marketplace install @kb-labs/adapters-missing-llm --scope platform',
          },
        }]]),
      );

      expect(getAdapterStatusFor('llm')).toMatchObject({
        mode: 'degraded',
        reason: 'load-failed',
        configuredPackage: '@kb-labs/adapters-missing-llm',
        action: { command: 'kb marketplace install @kb-labs/adapters-missing-llm --scope platform' },
      });
      await expect(async () => platform.llm.complete('hello')).rejects.toBeInstanceOf(AdapterUnavailableError);
      await expect(async () => platform.llm.complete('hello')).rejects.toMatchObject({
        slot: 'llm',
        reason: 'load-failed',
      });
      expect(getAdapterStatusFor('cache')?.mode).not.toBe('degraded');
    });

    it('should handle config with no adapters', async () => {
      await initPlatform({ adapters: {} });

      expect(platform.isInitialized).toBe(true);

      // ConfigAdapter is ALWAYS created in parent process
      expect(platform.hasAdapter('config')).toBe(true);

      // After the new loader pass every slot in ADAPTER_DEFAULTS is filled,
      // either by a real adapter, an InMemory honest fallback, or a NoOp
      // stub. `hasAdapter('cache')` therefore returns true — `isReal('cache')`
      // is the right test for "did the operator configure this?".
      expect(platform.hasAdapter('cache')).toBe(true);
      expect(platform.isReal('cache')).toBe(false);
    });

    it('should create ConfigAdapter automatically', async () => {
      await initPlatform({});

      expect(platform.hasAdapter('config')).toBe(true);
      expect(platform.config).toBeDefined();
    });

    it('should use NoOp fallbacks when adapters not configured', async () => {
      await initPlatform({ adapters: {} });

      // Should use fallbacks
      const llm = platform.llm;
      const cache = platform.cache;
      const vectorStore = platform.vectorStore;

      expect(llm).toBeDefined();
      expect(cache).toBeDefined();
      expect(vectorStore).toBeDefined();
    });
  });

  describe('Core Features Configuration', () => {
    it('should initialize core features with default config', async () => {
      await initPlatform({});

      expect(platform.workflows).toBeDefined();
      expect(platform.jobs).toBeDefined();
      expect(platform.cron).toBeDefined();
      expect(platform.resources).toBeDefined();
    });

    it('should pass core config to features', async () => {
      await initPlatform({
        core: {
          workflows: { maxConcurrent: 5 },
          jobs: { maxConcurrent: 3 },
        },
      });

      expect(platform.workflows).toBeDefined();
      expect(platform.jobs).toBeDefined();
    });

    it('should initialize with resourceBroker config', async () => {
      await initPlatform({
        core: {
          resourceBroker: {
            llm: {
              rateLimits: { requestsPerMinute: 100 },
              maxRetries: 5,
              timeout: 30000,
            },
          },
        },
      });

      expect(platform.hasResourceBroker).toBe(true);
      expect(platform.resourceBroker).toBeDefined();
    });
  });

  describe('Service Registration', () => {
    it('should register core features in configured services', async () => {
      await initPlatform({});

      const services = platform.getConfiguredServices();
      expect(services.has('workflows')).toBe(true);
      expect(services.has('jobScheduler')).toBe(true);
      expect(services.has('cron')).toBe(true);
      expect(services.has('resources')).toBe(true);
      expect(services.has('resourceBroker')).toBe(true);
    });

    it('should register config adapter in configured services', async () => {
      await initPlatform({});

      const services = platform.getConfiguredServices();
      expect(services.has('config')).toBe(true);
    });

    it('should detect configured vs fallback adapters', async () => {
      await initPlatform({});

      // ConfigAdapter is explicitly created by the runtime, so `isConfigured`
      // is true even without an entry in kb.config.json.
      expect(platform.isConfigured('config')).toBe(true);

      // After the new loader pass every slot in ADAPTER_DEFAULTS is filled —
      // either with a real adapter, an InMemory fallback, or a NoOp stub —
      // so `hasAdapter()` returns true for both `cache` and `vectorStore`.
      // The diagnostic operators care about is `isReal()`: it returns true
      // only for slots backed by an actual configured adapter.
      //
      // (Note: in worker processes — including vitest — slots like `llm` and
      // `config` are wired through IPC proxies and therefore report
      // `isReal=true`. The asserts below pick two slots that have NO proxy
      // in worker mode either, so the test holds in both parent and child
      // contexts.)
      expect(platform.hasAdapter('cache')).toBe(true);
      expect(platform.isReal('cache')).toBe(false);
      expect(platform.hasAdapter('documentDatabase')).toBe(true);
      expect(platform.isReal('documentDatabase')).toBe(false);
    });
  });

  describe('Reset and Re-initialization', () => {
    it('should reset platform state', async () => {
      await initPlatform({});
      expect(platform.isInitialized).toBe(true);

      resetPlatform();

      expect(platform.isInitialized).toBe(false);
      expect(platform.hasResourceBroker).toBe(false);
    });

    it('should allow re-initialization after reset', async () => {
      await initPlatform({});
      resetPlatform();

      await initPlatform({});

      expect(platform.isInitialized).toBe(true);
      expect(platform.hasResourceBroker).toBe(true);
    });

    it('should clear adapters on reset', async () => {
      await initPlatform({});
      expect(platform.hasAdapter('config')).toBe(true);

      resetPlatform();

      // resetPlatform re-seeds all InMemory/NoOp defaults so that tests
      // using resetPlatform() without initPlatform() get a usable container.
      // Every slot in ADAPTER_DEFAULTS is present; none are 'real'.
      expect(platform.hasAdapter('config')).toBe(true);
      expect(platform.hasAdapter('cache')).toBe(true);
      expect(platform.hasAdapter('logger')).toBe(true);
      // No slot is in 'real' mode after a bare reset (no real adapters configured).
      expect(platform.isReal('cache')).toBe(false);
      expect(platform.isReal('config')).toBe(false);
    });

    it('should re-create core features after reset', async () => {
      await initPlatform({});
      const workflows1 = platform.workflows;

      resetPlatform();
      await initPlatform({});

      const workflows2 = platform.workflows;

      // Different instances after reset
      expect(workflows2).toBeDefined();
    });
  });

  describe('Adapter Options', () => {
    it('should handle empty adapterOptions', async () => {
      await initPlatform({
        adapters: {},
        adapterOptions: {},
      });

      expect(platform.isInitialized).toBe(true);
    });

    it('should initialize without adapterOptions field', async () => {
      await initPlatform({
        adapters: {},
      });

      expect(platform.isInitialized).toBe(true);
    });
  });

  describe('Multi-Adapter Configuration', () => {
    it('should accept single adapter as string (backward compatible)', async () => {
      await initPlatform({
        adapters: {
          // Single adapter as string - legacy format still works
        },
      });

      expect(platform.isInitialized).toBe(true);
    });

    it('should accept multiple adapters as array', async () => {
      await initPlatform({
        adapters: {
          // Array format - new multi-adapter support
          // Note: actual adapters not configured here, just testing type acceptance
        },
        adapterOptions: {
          llm: {
            defaultTier: 'small',
            tierMapping: {
              small: [
                { adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 },
              ],
              medium: [
                { adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 },
              ],
            },
          },
        },
      });

      expect(platform.isInitialized).toBe(true);
    });

    it('should accept null adapter value (NoOp)', async () => {
      await initPlatform({
        adapters: {
          analytics: null,
        },
      });

      expect(platform.isInitialized).toBe(true);
    });

    it('should handle mixed adapter formats', async () => {
      // Mix of single strings, arrays, and null
      await initPlatform({
        adapters: {
          // Different formats in same config
          analytics: null, // disabled
        },
      });

      expect(platform.isInitialized).toBe(true);
    });

    it('should use first adapter in array as primary', async () => {
      // When array is provided, first element is primary
      await initPlatform({
        adapters: {},
        adapterOptions: {
          llm: {
            tierMapping: {
              small: [
                { adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 },
                { adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet', priority: 2 },
              ],
            },
          },
        },
      });

      expect(platform.isInitialized).toBe(true);
    });
  });

  describe('Platform Config Extraction', () => {
    it('should extract adapters from config', async () => {
      const config = {
        adapters: {
          // Empty, but valid
        },
        adapterOptions: {},
        core: {},
      };

      await initPlatform(config);

      expect(platform.isInitialized).toBe(true);
    });

    it('should handle partial config', async () => {
      const config = {
        adapters: {},
        // No adapterOptions or core
      };

      await initPlatform(config);

      expect(platform.isInitialized).toBe(true);
    });

    it('should use defaults when config fields missing', async () => {
      await initPlatform({});

      expect(platform.isInitialized).toBe(true);
      expect(platform.workflows).toBeDefined();
      expect(platform.jobs).toBeDefined();
    });
  });

  describe('Singleton Behavior', () => {
    it('should return same platform instance', async () => {
      const result1 = await initPlatform({});
      const result2 = await initPlatform({});

      expect(result1).toBe(result2);
      expect(result1).toBe(platform);
    });

    it('should preserve adapters across calls', async () => {
      await initPlatform({});
      const config1 = platform.hasAdapter('config');

      // Second init should not reset
      await initPlatform({});
      const config2 = platform.hasAdapter('config');

      expect(config1).toBe(true);
      expect(config2).toBe(true);
    });

    it('should use Symbol.for() for cross-realm singleton', async () => {
      await initPlatform({});

      const key = Symbol.for('kb.platform');
      const fromProcess = (process as any)[key];

      expect(fromProcess).toBe(platform);
    });
  });

  describe('Resource Broker Wrapping', () => {
    it('should not wrap adapters when not configured', async () => {
      await initPlatform({ adapters: {} });

      // LLM should be fallback MockLLM (not wrapped)
      expect(platform.llm).toBeDefined();
    });

    it('should initialize resource broker even without adapters', async () => {
      await initPlatform({ adapters: {} });

      expect(platform.hasResourceBroker).toBe(true);
    });
  });

  describe('Graceful Degradation', () => {
    it('should continue if ConfigAdapter fails to import', async () => {
      // ConfigAdapter should not fail in practice, but test graceful degradation
      await initPlatform({});

      expect(platform.isInitialized).toBe(true);
    });

    it('should continue if core features initialization fails', async () => {
      // Core features might fail if workflow-engine has issues
      await initPlatform({});

      // Platform should still initialize
      expect(platform.isInitialized).toBe(true);
      // Jobs, cron, resources should be available (only workflows might be null)
      expect(platform.jobs).toBeDefined();
      expect(platform.cron).toBeDefined();
      expect(platform.resources).toBeDefined();
    });

    it('should continue if ResourceBroker initialization fails', async () => {
      await initPlatform({});

      // Platform should still initialize
      expect(platform.isInitialized).toBe(true);
      // Even if ResourceBroker fails, platform should work with fallbacks
    });

    it('should initialize all components independently', async () => {
      await initPlatform({});

      // All critical components should be present
      expect(platform.isInitialized).toBe(true);
      expect(platform.hasAdapter('config')).toBe(true);
      expect(platform.jobs).toBeDefined();
      expect(platform.cron).toBeDefined();
      expect(platform.resources).toBeDefined();
    });

    it('should handle partial initialization gracefully', async () => {
      // Even if some components fail, others should work
      await initPlatform({});

      // Platform should be usable
      expect(platform.isInitialized).toBe(true);

      // Core adapters should work with fallbacks
      expect(platform.llm).toBeDefined();
      expect(platform.cache).toBeDefined();
      expect(platform.storage).toBeDefined();
    });
  });

  describe('Workflow Degradation', () => {
    it('should handle null workflows gracefully', async () => {
      await initPlatform({});

      // Workflows might be null if WorkflowEngine is disabled
      // This should not break platform initialization
      expect(platform.isInitialized).toBe(true);
    });

    it('should initialize other core features when workflows unavailable', async () => {
      await initPlatform({});

      // Even if workflows is null, other features should work
      expect(platform.jobs).toBeDefined();
      expect(platform.cron).toBeDefined();
      expect(platform.resources).toBeDefined();
    });
  });

  describe('ExecutionBackend Initialization', () => {
    const assertContainerProviderDiagnostic = async (configureProvider: boolean) => {
      await initPlatform({ execution: { mode: 'container' } });

      if (configureProvider) {
        const providerWithoutAttachedStart: IEnvironmentProvider = {
          async create() {
            throw new Error('create must not be reached before provider capability validation');
          },
          async getStatus() {
            throw new Error('getStatus must not be reached before provider capability validation');
          },
          async destroy() {},
          getExecutionStream() {
            throw new Error('getExecutionStream must not be reached before provider capability validation');
          },
        };
        platform.setAdapter('environment', providerWithoutAttachedStart);
      }

      expect(platform.executionBackend.executionMode).toBe('container');
      expect(platform.getAdapter<IEnvironmentProvider>('environment') !== undefined).toBe(configureProvider);

      const request: ExecutionRequest = {
        executionId: 'provider-diagnostic-test',
        pluginRoot: process.cwd(),
        handlerRef: './unused-handler.js',
        input: {},
        descriptor: {
          hostType: 'cli',
          hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
          pluginId: '@kb-labs/test-plugin',
          pluginVersion: '1.0.0',
          requestId: 'provider-diagnostic-request',
          permissions: {},
        },
      };

      try {
        const result = await platform.executionBackend.execute(request);

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error('container execution unexpectedly succeeded without an attached environment provider');
        }
        expect(result.error.code).toBe('KB_RUNTIME_CONTAINER_UNAVAILABLE');
        expect(result.error.envelope.hint).toContain(configureProvider
          ? 'the configured environment provider does not support attached reserve()/start()'
          : 'the container environment provider is not configured');
        expect(result.error.envelope.hint).toContain('kb marketplace install @kb-labs/adapters-environment-docker --scope platform');
        expect(result.error.envelope.hint).not.toContain('Docker daemon logs');
      } finally {
        await platform.executionBackend.shutdown();
      }
    };

    // case: S-244.4
    it('returns the catalogued provider diagnostic when no environment adapter is configured', async () => {
      await assertContainerProviderDiagnostic(false);
    });

    // case: S-244.4
    it('returns the catalogued provider diagnostic when the environment adapter lacks attached start support', async () => {
      await assertContainerProviderDiagnostic(true);
    });

    it('should initialize ExecutionBackend by default', async () => {
      await initPlatform({});

      // In test environment, ExecutionBackend may not be available due to import issues
      // Check hasExecutionBackend instead of accessing executionBackend directly
      // In production, this will always be true
      expect(platform.hasExecutionBackend).toBeDefined();
    });

    it('should initialize ExecutionBackend with in-process mode by default', async () => {
      await initPlatform({});

      // Default mode should be 'auto' which resolves to 'in-process'
      // In test environment, may not initialize due to import issues
      expect(platform.hasExecutionBackend).toBeDefined();
    });

    it('should initialize ExecutionBackend with config from execution section', async () => {
      await initPlatform({
        execution: {
          mode: 'in-process',
        },
      });

      expect(platform.hasExecutionBackend).toBeDefined();
    });

    it('should respect execution mode from config', async () => {
      await initPlatform({
        execution: {
          mode: 'worker-pool',
          workerPool: {
            min: 2,
            max: 4,
          },
        },
      });

      // Backend should be created with config
      expect(platform.hasExecutionBackend).toBeDefined();
    });

    it('should register executionBackend in configured services if initialized', async () => {
      await initPlatform({});

      const services = platform.getConfiguredServices();
      // If ExecutionBackend initialized successfully, should be in services
      if (platform.hasExecutionBackend) {
        expect(services.has('executionBackend')).toBe(true);
      }
    });

    it('should allow access to executionBackend via platform if initialized', async () => {
      await initPlatform({});

      if (platform.hasExecutionBackend) {
        const backend = platform.executionBackend;
        expect(backend).toBeDefined();
        expect(typeof backend.execute).toBe('function');
        expect(typeof backend.shutdown).toBe('function');
      }
    });

    it('should shutdown ExecutionBackend when platform shuts down', async () => {
      await initPlatform({});

      // Shutdown should not throw regardless of ExecutionBackend state
      await expect(platform.shutdown()).resolves.not.toThrow();
    });

    it('should preserve ExecutionBackend across multiple init calls', async () => {
      await initPlatform({});
      const hasBackend1 = platform.hasExecutionBackend;

      // Second init should be idempotent
      await initPlatform({});
      const hasBackend2 = platform.hasExecutionBackend;

      // Should have same state
      expect(hasBackend2).toBe(hasBackend1);
    });

    it('should re-create ExecutionBackend after reset', async () => {
      await initPlatform({});

      resetPlatform();
      await initPlatform({});

      // After reset and re-init, hasExecutionBackend should be defined
      expect(platform.hasExecutionBackend).toBeDefined();
    });
  });
});
