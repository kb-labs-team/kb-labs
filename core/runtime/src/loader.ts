/**
 * @module @kb-labs/core-runtime/loader
 * Platform initialization and adapter loading.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PlatformContainer } from './container.js';
import type { PlatformConfig, CoreFeaturesConfig, ResourceBrokerConfig, LLMAdapterOptions, AdapterValue, NotifierAdapterOptions } from './config.js';
import { platform } from './container.js';
import { resolveAdapter } from './discover-adapters.js';
import { createAnalyticsContext } from './analytics-context.js';
import { AdapterLoader } from './adapter-loader.js';
import type { AdapterConfig, LoadedAdapterModule } from './adapter-loader.js';
import { EnvironmentManager } from './environment-manager.js';
import { WorkspaceManager } from './workspace-manager.js';
import { SnapshotManager } from './snapshot-manager.js';
import { RunExecutor } from './run-executor.js';
import { RunOrchestrator } from './run-orchestrator.js';
import { createDefaultExecutionPolicyLLM } from './wrappers/default-execution-policy-llm.js';

import { ResourceManager } from './core/resource-manager.js';
import { JobScheduler } from './core/job-scheduler.js';
import { CronManager } from './core/cron-manager.js';
import {
  getAdapterStatusRegistry,
  resetAdapterStatus,
} from './adapter-status.js';
import { ADAPTER_DEFAULTS, type AdapterSlot } from '@kb-labs/core-platform';
import { inmemoryFactories } from '@kb-labs/core-platform/inmemory';
import { noopFactories } from '@kb-labs/core-platform/noop';
import { WorkflowEngine } from './core/workflow-engine.js';

const OPTIONAL_ADAPTER_SLOTS = new Set(['logPersistence', 'logRingBuffer']);

function selectPackageExport(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const conditions = value as Record<string, unknown>;
  for (const condition of ['import', 'default', 'require']) {
    const entry = conditions[condition];
    if (typeof entry === 'string') {
      return entry;
    }
  }
  return undefined;
}

async function resolveFromPlatformPackage(
  modulePath: string,
  basePkgName: string,
  platformRoot: string,
): Promise<{ modulePath: string; pkgRoot: string }> {
  const packageRoot = path.join(platformRoot, 'node_modules', basePkgName);
  const packageJson = JSON.parse(
    await fs.readFile(path.join(packageRoot, 'package.json'), 'utf-8'),
  ) as { main?: string; exports?: unknown };
  const subpath = modulePath.slice(basePkgName.length);
  const exportKey = subpath ? `.${subpath}` : '.';
  const exportsMap = packageJson.exports;
  const exported =
    exportsMap && typeof exportsMap === 'object' && !Array.isArray(exportsMap)
      ? (exportsMap as Record<string, unknown>)[exportKey]
      : undefined;
  const entry = selectPackageExport(exported) ?? (!subpath ? packageJson.main : undefined);

  if (!entry) {
    throw new Error(`Package ${basePkgName} does not export ${exportKey}`);
  }

  return { modulePath: path.resolve(packageRoot, entry), pkgRoot: packageRoot };
}

import { AnalyticsLLM } from '@kb-labs/core-platform';
import type {
  IEnvironmentProvider,
  IWorkspaceProvider,
  ILLM,
  IAnalytics,
  LLMOptions,
  VectorFilter,
  VectorRecord,
  RawMiddlewareDecl,
} from '@kb-labs/core-platform';
import type { ExecutionRequest } from '@kb-labs/core-contracts';

import { ResourceBroker, InMemoryRateLimitBackend } from '@kb-labs/core-resource-broker';
import type { RateLimitBackend, IResourceBroker } from '@kb-labs/core-resource-broker';

// Import ExecutionBackend type only (implementation loaded dynamically to break circular dependency)

/**
 * Adapter factory function type.
 * Adapters should export a createAdapter function.
 */
type AdapterFactory<T> = (config?: unknown) => T | Promise<T>;

/**
 * Normalize adapter value to array format.
 * - string → [string]
 * - string[] → string[]
 * - null/undefined → []
 *
 * @param value - Adapter value (string, string[], or null)
 * @returns Array of adapter package paths
 */
function normalizeAdapterValue(value: AdapterValue | undefined): string[] {
  if (!value) {return [];}
  if (Array.isArray(value)) {return value;}
  return [value];
}

/**
 * Get primary adapter from value (first in array or single string).
 *
 * @param value - Adapter value
 * @returns Primary adapter package path or undefined
 */
function getPrimaryAdapter(value: AdapterValue | undefined): string | undefined {
  if (!value) {return undefined;}
  if (Array.isArray(value)) {return value[0];}
  return value;
}

/**
 * Load an adapter from a package path.
 * Uses workspace discovery to load from file paths (kb-labs-adapters/*),
 * then falls back to dynamic import for npm-installed adapters.
 *
 * @param adapterPath - Package name (e.g., "@kb-labs/adapters-openai")
 * @param cwd - Workspace root directory
 * @returns Adapter instance or undefined if loading fails
 */
async function loadAdapter<T>(adapterPath: string, cwd: string, options?: unknown, platformRoot?: string): Promise<T | undefined> {
  try {
    // Use resolveAdapter to try workspace discovery first, then npm
    const factory = await resolveAdapter(adapterPath, cwd, platformRoot);

    if (factory) {
      return (await factory(options)) as T;
    }

    platform.logger.warn('Adapter has no createAdapter or default export', { adapterPath });
    return undefined;
  } catch (error) {
    platform.logger.warn('Failed to load adapter', {
      adapterPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}


/**
 * Walk `ADAPTER_DEFAULTS`, decide the mode of every slot, install
 * fallbacks where needed, and record the result in the global adapter
 * status registry.
 *
 * Three branches per slot:
 *
 * 1. **Configured + loaded successfully** → record `mode: 'real'` with
 *    the configured package name.
 *
 * 2. **Configured but NOT loaded** → fail-fast. The operator asked for a
 *    specific adapter; silent degradation would hide a real bug.
 *    Implementations of `AdapterLoader` that swallow individual failures
 *    are responsible for surfacing them earlier; this function is the
 *    last line of defence that turns the silent miss into a thrown
 *    error.
 *
 * 3. **Not configured** → install the policy-driven fallback from
 *    `ADAPTER_DEFAULTS[slot].defaultFallback`. Either an InMemory honest
 *    implementation or a NoOp stub that throws `AdapterUnavailableError`
 *    on use.
 *
 * After this function returns, every slot in `ADAPTER_DEFAULTS` is
 * guaranteed to be filled (except `snapshotManager`, which has no
 * sensible NoOp shape — callers handle `undefined` for it specifically).
 *
 * Throws on the configured-but-failed branch only; never throws for
 * legitimately unconfigured slots.
 */
function fillAdapterFallbacksAndRecord(
  container: PlatformContainer,
  adapters: Record<string, AdapterValue | undefined>,
): void {
  const status = getAdapterStatusRegistry();
  const now = (): string => new Date().toISOString();

  const slots = Object.keys(ADAPTER_DEFAULTS) as AdapterSlot[];

  // Pre-scan: fail-fast before installing any fallbacks if a configured adapter
  // failed to load. This prevents the platform from starting in a half-initialised
  // state where some slots have InMemory/NoOp fallbacks while others are missing.
  const failures: string[] = [];
  for (const slot of slots) {
    const configuredPkg = getPrimaryAdapter(adapters[slot]);
    if (configuredPkg && !container.hasAdapter(slot)) {
      failures.push(`  - "${slot}" was configured as "${configuredPkg}" but no adapter was loaded.`);
    }
  }
  if (failures.length > 0) {
    const lines = [
      'Platform startup aborted: configured adapters failed to load.',
      ...failures,
      '',
      'A configured adapter must succeed at every stage (import, factory, validation).',
      'Check kb.config.json, .kb/marketplace.lock, and that the listed packages are installed.',
      'Run `kb platform provision --mode reconcile` (deploy) or `kb marketplace install <pkg>` (dev).',
    ];
    throw new Error(lines.join('\n'));
  }

  // Main pass: record real adapters and install InMemory/NoOp fallbacks.
  for (const slot of slots) {
    // Idempotency guard: skip slots already recorded (prevents double-call
    // corruption when fillAdapterFallbacksAndRecord is called on both child
    // and parent paths in the same process — the second call is a no-op).
    if (status.get(slot)) {
      continue;
    }

    const desc = ADAPTER_DEFAULTS[slot];
    const configuredPkg = getPrimaryAdapter(adapters[slot]);
    const hasPresent = container.hasAdapter(slot);

    // Branch 1: configured + loaded — record as real.
    if (hasPresent && configuredPkg) {
      status.record({
        slot,
        mode: 'real',
        implementation: configuredPkg,
        configuredPackage: configuredPkg,
        recordedAt: now(),
      });
      continue;
    }

    // Branch 1b: adapter present but not in config — bootstrap fallback
    // (e.g. ConsoleLogger seeded in the container constructor).
    // Re-classify by fallback policy: do NOT record as 'real'.
    if (hasPresent && !configuredPkg) {
      const impl = container.getAdapter(slot) as object;
      const implName = Object.getPrototypeOf(impl)?.constructor?.name ?? 'unknown';
      const mode = desc.defaultFallback === 'inmemory' ? 'inmemory' : 'noop';
      status.record({
        slot,
        mode,
        implementation: implName,
        reason: 'not-configured',
        recordedAt: now(),
      });
      continue;
    }

    // Branch 3: not configured and not present — install fallback per policy.
    if (desc.defaultFallback === 'inmemory') {
      const factory = (inmemoryFactories as Record<string, (() => unknown) | undefined>)[slot];
      if (!factory) {
        // Coverage gap between ADAPTER_DEFAULTS and inmemoryFactories. The
        // satisfies-typed factory map is supposed to make this impossible;
        // surface it loudly so the missing entry gets added.
        throw new Error(
          `inmemoryFactories has no entry for slot "${slot}", but ADAPTER_DEFAULTS demands InMemory fallback. ` +
            `Add a factory to core/platform/src/inmemory/index.ts.`,
        );
      }
      const impl = factory();
      container.setAdapter(slot, impl as never);
      status.record({
        slot,
        mode: 'inmemory',
        implementation: Object.getPrototypeOf(impl as object)?.constructor?.name ?? 'unknown',
        reason: 'not-configured',
        recordedAt: now(),
      });
      container.logger.warn(
        `Adapter "${slot}" using InMemory fallback — data lives in-process only`,
        { slot, reason: 'not-configured' },
      );
      continue;
    }

    // defaultFallback === 'noop'
    const factory = (noopFactories as Record<string, (() => unknown) | undefined>)[slot];
    if (!factory) {
      // Slot legitimately has no NoOp stub (e.g. snapshotManager). Leave
      // the container entry undefined; consumers handle `undefined` for
      // optional slots already.
      continue;
    }
    const impl = factory();
    container.setAdapter(slot, impl as never);
    status.record({
      slot,
      mode: 'noop',
      implementation: Object.getPrototypeOf(impl as object)?.constructor?.name ?? 'unknown',
      reason: 'not-configured',
      recordedAt: now(),
    });
    container.logger.warn(
      `Adapter "${slot}" using NoOp fallback — calls will throw AdapterUnavailableError`,
      { slot, reason: 'not-configured' },
    );
  }

  // Boot summary — one line, scannable in logs.
  const counts = { real: 0, inmemory: 0, noop: 0 };
  for (const row of status.list()) {
    counts[row.mode]++;
  }
  container.logger.info(
    `Adapters initialised: ${counts.real} real, ${counts.inmemory} inmemory, ${counts.noop} noop`,
    counts,
  );
}

/**
 * Initialize core features with real implementations.
 */
function initializeCoreFeatures(
  container: PlatformContainer,
  config: CoreFeaturesConfig = {}
): {
  workflows: WorkflowEngine;
  jobs: JobScheduler;
  cron: CronManager;
  resources: ResourceManager;
} {
  // Create core features with proper dependencies
  const resources = new ResourceManager(
    container.cache,
    container.logger,
    config.resources
  );

  const jobs = new JobScheduler(
    resources,
    container.eventBus,
    container.logger,
    config.jobs
  );

  const cron = new CronManager(container.logger);

  const workflows = new WorkflowEngine(
    resources,
    container.storage,
    container.eventBus,
    container.logger,
    config.workflows
  );

  return { workflows, jobs, cron, resources };
}

/**
 * Initialize resource broker with queue and rate limiting.
 * Wraps existing adapters with Queued versions for transparent integration.
 * Plugins use useLLM(), useEmbeddings() as before - they don't know about queuing.
 */
function initializeResourceBroker(
  container: PlatformContainer,
  config: ResourceBrokerConfig = {}
): ResourceBroker {
  // Create backend (distributed or in-memory)
  let backend: RateLimitBackend;

  if (config.distributed) {
    // For distributed mode, we need StateBroker
    // This will be implemented when StateBroker is available
    platform.logger.warn('Distributed ResourceBroker not yet implemented, using InMemory');
    backend = new InMemoryRateLimitBackend();
  } else {
    backend = new InMemoryRateLimitBackend();
  }

  const broker = new ResourceBroker(backend);

  // Register LLM resource with broker (queuing applied later by assemblePlatform.resourceBrokerFactory)
  if (container.isReal('llm')) {
    const llmConfig = config.llm ?? {};
    const realLLM = container.llm;

    broker.register('llm', {
      rateLimits: llmConfig.rateLimits ?? 'openai-tier-1',
      maxRetries: llmConfig.maxRetries ?? 3,
      timeout: llmConfig.timeout ?? 60000,
      executor: async (operation: string, args: unknown[]) => {
        if (operation === 'complete') {
          return realLLM.complete(args[0] as string, args[1] as LLMOptions | undefined);
        }
        throw new Error(`Unknown LLM operation: ${operation}`);
      },
    });
  }

  // Register Embeddings resource with broker (queuing applied later by assemblePlatform.resourceBrokerFactory)
  if (container.isReal('embeddings')) {
    const embeddingsConfig = config.embeddings ?? {};
    const realEmbeddings = container.embeddings;

    broker.register('embeddings', {
      rateLimits: embeddingsConfig.rateLimits ?? 'openai-tier-1',
      maxRetries: embeddingsConfig.maxRetries ?? 3,
      timeout: embeddingsConfig.timeout ?? 60000,
      executor: async (operation: string, args: unknown[]) => {
        if (operation === 'embed') {
          return realEmbeddings.embed(args[0] as string);
        }
        if (operation === 'embedBatch') {
          return realEmbeddings.embedBatch(args[0] as string[]);
        }
        throw new Error(`Unknown Embeddings operation: ${operation}`);
      },
    });
  }

  // Register VectorStore resource with broker (queuing applied later by assemblePlatform.resourceBrokerFactory)
  if (container.isReal('vectorStore')) {
    const vsConfig = config.vectorStore ?? {};
    const realVectorStore = container.vectorStore;

    broker.register('vectorStore', {
      rateLimits: vsConfig.maxConcurrent ? { maxConcurrentRequests: vsConfig.maxConcurrent } : {},
      maxRetries: vsConfig.maxRetries ?? 3,
      timeout: vsConfig.timeout ?? 30000,
      executor: async (operation: string, args: unknown[]) => {
        switch (operation) {
          case 'search':
            return realVectorStore.search(
              args[0] as number[],
              args[1] as number,
              args[2] as VectorFilter | undefined,
              args[3] as string | undefined,
            );
          case 'upsert':
            return realVectorStore.upsert(args[0] as VectorRecord[], args[1] as string | undefined);
          case 'delete':
            return realVectorStore.delete(args[0] as string[], args[1] as string | undefined);
          case 'count':
            return realVectorStore.count(args[0] as string | undefined);
          case 'get':
            return realVectorStore.get?.(args[0] as string[], args[1] as string | undefined);
          case 'query':
            return realVectorStore.query?.(args[0] as VectorFilter, args[1] as string | undefined);
          default:
            throw new Error(`Unknown VectorStore operation: ${operation}`);
        }
      },
    });
  }

  return broker;
}

/**
 * Initialize the platform with configuration.
 * Loads adapters and initializes core features.
 *
 * @param config - Platform configuration
 * @param cwd - Workspace root directory (defaults to process.cwd())
 * @returns Initialized platform container
 *
 * @example
 * ```typescript
 * await initPlatform({
 *   adapters: {
 *     analytics: '@kb-labs/analytics-adapter',
 *     vectorStore: '@kb-labs/adapters-qdrant',
 *     llm: '@kb-labs/adapters-openai',
 *   },
 *   core: {
 *     resources: { defaultQuotas: { ... } },
 *     jobs: { maxConcurrent: 10 },
 *   },
 * });
 * ```
 */
export async function initPlatform(
  config: PlatformConfig = {},
  cwd: string = process.cwd(),
  uiProvider?: (hostType: string) => any,
  platformRoot?: string,
  assemblyHook?: (
    platform: PlatformContainer,
    broker: IResourceBroker,
    adapterConfig: Partial<Record<string, unknown>>,
  ) => Partial<Record<string, unknown>>,
): Promise<PlatformContainer> {

  // ✅ Idempotent: If already initialized, return existing singleton
  // This prevents duplicate adapter instances across CLI and sandbox processes
  platform.logger.debug(`initPlatform isInitialized=${platform.isInitialized} pid=${process.pid}`);

  if (platform.isInitialized) {
    platform.logger.debug(`initPlatform returning existing platform pid=${process.pid}`);
    return platform;
  }

  platform.logger.debug(`initPlatform initializing NEW platform pid=${process.pid}`);
  const { adapters = {}, adapterOptions = {}, core = {}, execution = {} } = config;

  // 🔍 Detect if running in child process (sandbox worker)
  const isChildProcess = !!process.send; // Has IPC channel = forked child
  const initStartedAt = Date.now();

  await platform.emitLifecyclePhase('start', {
    cwd,
    isChildProcess,
    metadata: {
      adapterKeys: Object.keys(adapters),
      hasExecutionConfig: Object.keys(execution).length > 0,
      pid: process.pid,
    },
  });

  try {
    if (isChildProcess) {
    // ══════════════════════════════════════════════════════════════════════
    // CHILD PROCESS (Sandbox Worker)
    // ══════════════════════════════════════════════════════════════════════
    // Create IPC proxy adapters that forward calls to parent process.
    // This eliminates adapter duplication - only parent has real adapters.

    platform.logger.debug('initPlatform child process detected - creating proxy adapters');

    // Use Unix Socket transport by default (100-1000x faster than IPC for large messages)
    const {
      UnixSocketTransport,
      VectorStoreProxy,
      CacheProxy,
      ConfigProxy,
      LLMProxy,
      EmbeddingsProxy,
      StorageProxy,
    } = await import('@kb-labs/core-ipc');

    // Create single transport for all adapters
    const transport = new UnixSocketTransport();
    platform.logger.debug('initPlatform using Unix Socket transport');

    // Create proxy adapters (replace real adapters with IPC proxies)
    if (adapters.vectorStore) {
      platform.setAdapter('vectorStore', new VectorStoreProxy(transport));
      platform.logger.debug('initPlatform created VectorStoreProxy');
    }

    if (adapters.cache) {
      platform.setAdapter('cache', new CacheProxy(transport));
      platform.logger.debug('initPlatform created CacheProxy');
    }

    // Config adapter is ALWAYS created (not optional like other adapters)
    platform.setAdapter('config', new ConfigProxy(transport));
    platform.logger.debug('initPlatform created ConfigProxy');

    // LLM proxy is ALWAYS created (parent may have real LLM even if not in child config)
    const llmOptions = (adapterOptions.llm ?? {}) as LLMAdapterOptions;
    platform.setAdapter('llm', new LLMProxy(transport, {
      defaultTier: llmOptions.defaultTier ?? llmOptions.tier ?? 'small',
      tierMapping: llmOptions.tierMapping,
      capabilities: llmOptions.capabilities,
    }));
    platform.logger.debug('initPlatform created LLMProxy');

    if (adapters.embeddings) {
      const embeddingsProxy = new EmbeddingsProxy(transport);
      await embeddingsProxy.getDimensions(); // Initialize dimensions before use
      platform.setAdapter('embeddings', embeddingsProxy);
      platform.logger.debug('initPlatform created EmbeddingsProxy');
    }

    if (adapters.storage) {
      platform.setAdapter('storage', new StorageProxy(transport));
      platform.logger.debug('initPlatform created StorageProxy');
    }

    // Fill remaining slots with InMemory/NoOp fallbacks and populate the
    // adapter-status registry. Slots the parent already wired through a
    // proxy stay untouched and are recorded as `mode: 'real'`; slots
    // without a proxy fall back per `ADAPTER_DEFAULTS`.
    fillAdapterFallbacksAndRecord(
      platform,
      adapters as Record<string, AdapterValue | undefined>,
    );

    // ⚠️ CRITICAL: Do NOT create ExecutionBackend in child process!
    // Child processes ARE the workers - creating backend here would spawn infinite workers.
    // ExecutionBackend is ONLY created in parent process.

    // Core features are initialized normally (they don't duplicate resources)
    const coreFeatures = initializeCoreFeatures(platform, core);
    platform.initCoreFeatures(
      coreFeatures.workflows,
      coreFeatures.jobs,
      coreFeatures.cron,
      coreFeatures.resources
    );

    // Initialize ResourceBroker for queue and rate limiting
    const resourceBroker = initializeResourceBroker(platform, core.resourceBroker);
    platform.initResourceBroker(resourceBroker);
    platform.logger.debug('initPlatform initialized ResourceBroker');

    platform.logger.debug('initPlatform child process initialization complete');

    } else {
    // ══════════════════════════════════════════════════════════════════════
    // PARENT PROCESS (CLI bin)
    // ══════════════════════════════════════════════════════════════════════
    // Load real adapters (Qdrant, Redis, OpenAI, etc.)
    // Start IPC server to handle calls from child processes.

    platform.logger.debug('initPlatform parent process detected - loading real adapters');

    // Create analytics context for auto-enrichment (once per execution)
    const analyticsContext = await createAnalyticsContext(cwd);
    platform.logger.debug('initPlatform created analytics context', {
      product: analyticsContext.source.product,
      version: analyticsContext.source.version,
      actorType: analyticsContext.actor?.type,
      runId: analyticsContext.runId,
    });

    // Use AdapterLoader for dependency resolution and proper loading order
    const loader = new AdapterLoader();

    // Create runtime contexts registry
    // Adapters declare which contexts they need via manifest.contexts
    const runtimeContexts: Record<string, unknown> = {
      workspace: { cwd },
      analytics: analyticsContext,
    };

    // Module loader function - defined before loop so we can pre-load manifests
    const loadModule = async (modulePath: string): Promise<LoadedAdapterModule> => {
      try {
        const { discoverAdapters } = await import('./discover-adapters.js');
        // Project wins: pass both roots so workspace adapters override platform's.
        // projectRoot is only distinct from platformRoot in installed (prod) mode.
        const discovered = await discoverAdapters(
          platformRoot ?? cwd,
          platformRoot && platformRoot !== cwd ? cwd : undefined,
        );

        // Parse module path into base package and subpath (same logic as resolveAdapter)
        const basePkgName = modulePath.split('/').slice(0, 2).join('/'); // "@kb-labs/adapters-openai"
        const subpath =
          modulePath.includes('/') && modulePath.split('/').length > 2
            ? modulePath.split('/').slice(2).join('/')
            : null; // "embeddings" or null

        const adapter = discovered.get(basePkgName);

        if (adapter && subpath) {
          // Load subpath export from workspace adapter
          const subpathFile = path.join(adapter.pkgRoot, 'dist', `${subpath}.js`);
          try {
            await fs.access(subpathFile);
            const module = await import(pathToFileURL(subpathFile).href);

            const factory = module.createAdapter || module.default;
            const manifest = module.manifest;

            if (!factory) {
              throw new Error(
                `Subpath ${modulePath} has no createAdapter or default export`
              );
            }

            if (!manifest) {
              throw new Error(
                `Subpath ${modulePath} has no manifest export`
              );
            }

            return { createAdapter: factory, manifest, pkgRoot: adapter.pkgRoot };
          } catch (err) {
            // Subpath file doesn't exist, try loading base package
            const baseModule = await import(
              pathToFileURL(
                path.join(adapter.pkgRoot, 'dist', 'index.js')
              ).href
            );

            const factory = baseModule.createAdapter || baseModule.default;
            const manifest = baseModule.manifest;

            if (!factory) {
              throw new Error(
                `Module ${modulePath} has no createAdapter or default export`
              );
            }

            if (!manifest) {
              throw new Error(
                `Module ${modulePath} has no manifest export`
              );
            }

            return { createAdapter: factory, manifest, pkgRoot: adapter.pkgRoot };
          }
        } else if (adapter) {
          // Load base package (no subpath)
          const module = await import(
            pathToFileURL(
              path.join(adapter.pkgRoot, 'dist', 'index.js')
            ).href
          );

          const factory = module.createAdapter || module.default;
          const manifest = module.manifest;

          if (!factory) {
            throw new Error(
              `Module ${modulePath} has no createAdapter or default export`
            );
          }

          if (!manifest) {
            throw new Error(
              `Module ${modulePath} has no manifest export`
            );
          }

          return { createAdapter: factory, manifest, pkgRoot: adapter.pkgRoot };
        } else {
          // Built-in adapters belong to the platform distribution, not to an
          // individual service bundle. Resolve from the platform root so every
          // launched service sees the same installed adapter set.
          const resolutionRoot = platformRoot ?? cwd;
          const platformRequire = createRequire(
            path.join(resolutionRoot, 'package.json'),
          );
          let resolvedModulePath: string;
          let pkgRoot: string | undefined;
          try {
            resolvedModulePath = platformRequire.resolve(modulePath);
          } catch {
            const resolved = await resolveFromPlatformPackage(
              modulePath,
              basePkgName,
              resolutionRoot,
            );
            resolvedModulePath = resolved.modulePath;
            pkgRoot = resolved.pkgRoot;
          }
          const module = await import(pathToFileURL(resolvedModulePath).href);

          const factory = module.createAdapter || module.default;
          const manifest = module.manifest;

          if (!factory) {
            throw new Error(
              `Module ${modulePath} has no createAdapter or default export`
            );
          }

          if (!manifest) {
            throw new Error(
              `Module ${modulePath} has no manifest export`
            );
          }

          // Find the package root from the resolved ESM entrypoint. This avoids
          // CommonJS resolution, which cannot resolve ESM-only `import` exports.
          try {
            let candidate = path.dirname(resolvedModulePath);
            while (candidate !== path.dirname(candidate)) {
              try {
                const packageJson = JSON.parse(
                  await fs.readFile(path.join(candidate, 'package.json'), 'utf-8'),
                ) as { name?: string };
                if (packageJson.name === basePkgName) {
                  pkgRoot = candidate;
                  break;
                }
              } catch {
                // Keep walking up until the adapter package root is found.
              }
              candidate = path.dirname(candidate);
            }
          } catch {
            // pkgRoot unavailable for this adapter — middleware handler files won't be loadable
          }

          return { createAdapter: factory, manifest, pkgRoot };
        }
      } catch (error) {
        throw new Error(
          `Failed to load adapter module ${modulePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    // Build adapter configs for AdapterLoader
    // Supports both single adapter (string) and multi-adapter (string[]) config
    const adapterConfigs: Record<string, AdapterConfig> = {};

    // Collect raw middleware declarations from adapter manifests (resolved later by execution backends)
    const rawMiddlewareDecls: RawMiddlewareDecl[] = [];

    // Track all available adapters for multi-adapter routing (LLM tier switching, etc.)
    const availableAdapters: Record<string, string[]> = {};

    for (const [name, adapterValue] of Object.entries(adapters)) {
      // Normalize to array and get primary adapter
      const adapterPackages = normalizeAdapterValue(adapterValue as AdapterValue);
      const primaryAdapter = getPrimaryAdapter(adapterValue as AdapterValue);

      if (!primaryAdapter) {continue;}

      // Store all available adapters for this type (used by LLMRouter, etc.)
      availableAdapters[name] = adapterPackages;

      try {
        // Pre-load module to access manifest (primary adapter only)
        const module = await loadModule(primaryAdapter);
        const baseOptions = (adapterOptions as Record<string, unknown>)[name] ?? {};

        // Inject requested contexts from manifest
        const requestedContexts = module.manifest.contexts ?? [];
        const contexts: Record<string, unknown> = {};

        for (const ctxName of requestedContexts) {
          if (runtimeContexts[ctxName]) {
            contexts[ctxName] = runtimeContexts[ctxName];
          }
        }

        adapterConfigs[name] = {
          module: primaryAdapter,
          // Merge contexts with user options (user options can override)
          config: { ...contexts, ...baseOptions },
        };

        // Collect middleware declarations from manifest
        if (module.pkgRoot && module.manifest.middlewares?.length) {
          for (const decl of module.manifest.middlewares) {
            rawMiddlewareDecls.push({ pkgRoot: module.pkgRoot, decl });
          }
        }

        // Log multi-adapter setup
        if (adapterPackages.length > 1) {
          platform.logger.debug(`initPlatform multi-adapter setup for ${name}`, {
            primary: primaryAdapter,
            available: adapterPackages,
          });
        }
      } catch (error) {
        if (OPTIONAL_ADAPTER_SLOTS.has(name)) {
          platform.logger.warn('Optional platform adapter unavailable; capability disabled', {
            adapterSlot: name,
            adapter: primaryAdapter,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        throw error;
      }
    }

    // Load adapters with dependency resolution. Configured adapters that
    // fail to load surface in the next pass via `fillAdapterFallbacksAndRecord`,
    // which throws a single combined error listing every failed slot.
    const loadedAdapters = await loader.loadAdapters(adapterConfigs, loadModule);

    // CRITICAL: Set analytics adapter FIRST (without wrapping) so wrapWithAnalytics() can use it
    if (loadedAdapters.has('analytics')) {
      platform.setAdapter('analytics', loadedAdapters.get('analytics') as IAnalytics);
      platform.logger.debug('initPlatform loaded adapter: analytics → FileAnalytics (set early for wrapping)');
    }

    // Set raw adapters in platform — analytics/router/broker wrapping is done by assemblePlatform
    for (const [name, instance] of loadedAdapters.entries()) {
      if (name === 'analytics') {continue;}
      platform.setAdapter(name, instance);
      platform.logger.debug(
        `initPlatform loaded adapter: ${name} → ${Object.getPrototypeOf(instance as object)?.constructor?.name ?? 'Unknown'}`
      );
    }

    // Get dependency graph for extension connection
    const graph = await loader.buildDependencyGraph(adapterConfigs, loadModule);
    loader.connectExtensions(loadedAdapters, graph);

    // Create ConfigAdapter (ALWAYS present, not loaded dynamically)
    try {
      const { ConfigAdapter } = await import('./adapters/config-adapter.js');
      platform.setAdapter('config', new ConfigAdapter());
      platform.logger.debug('initPlatform created ConfigAdapter');
    } catch (error) {
      platform.logger.warn('Failed to create ConfigAdapter, using NoOp fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fill remaining slots with InMemory/NoOp fallbacks per ADAPTER_DEFAULTS,
    // record what's wired into each slot, and fail-fast on any configured
    // adapter that didn't load. After this call, every slot in
    // ADAPTER_DEFAULTS is filled (or, for snapshotManager which has no
    // sensible NoOp, is intentionally left undefined).
    // ══════════════════════════════════════════════════════════════════════
    fillAdapterFallbacksAndRecord(
      platform,
      adapters as Record<string, AdapterValue | undefined>,
    );

    // ══════════════════════════════════════════════════════════════════════
    // Initialize ExecutionBackend (AFTER adapters, BEFORE core features)
    // CRITICAL: ExecutionBackend is REQUIRED - all execution goes through it
    // ══════════════════════════════════════════════════════════════════════
    try {
      if (execution.mode === 'container' && execution.container) {
        // ── Container mode: RoutingBackend with remote dispatch via Gateway ──
        // Dynamic imports — pyramid rule: core-runtime (L4) cannot depend on gateway-* (L7) at compile-time.
        const { createIsolatedExecutionBackend } = await import('@kb-labs/plugin-execution-factory');
        const { GatewayDispatchTransport } = await import('@kb-labs/gateway-core');
        const containerCfg = execution.container;

        const strictIsolation = {
          buildTransport(ctx: { runtimeHostId: string; namespaceId: string }) {
            return new GatewayDispatchTransport({
              dispatchEndpoint: containerCfg.gatewayDispatchUrl,
              internalSecret: containerCfg.gatewayInternalSecret,
              runtimeHostId: ctx.runtimeHostId,
              namespaceId: ctx.namespaceId,
              retryOn503: { maxAttempts: 30, delayMs: 1000 },
            });
          },
          workspaceRootOnHost: cwd,

          async provisionEnvironment(request: ExecutionRequest) {
            const namespace = request.target?.namespace
              ?? (request.context?.tenantId ? `tenant/${request.context.tenantId}` : 'default');
            const provisioningRunId = `exec-${randomUUID().slice(0, 12)}`;

            let createdWorkspaceId: string | undefined;
            let workspaceRootPath: string | undefined;

            const workspaceProvider = platform.getAdapter<IWorkspaceProvider>('workspace');
            if (workspaceProvider) {
              const workspace = await workspaceProvider.materialize({
                namespace,
                sourceRef: cwd,
                basePath: cwd,
                metadata: {
                  source: 'auto-provision',
                  executionId: request.executionId,
                  provisioningRunId,
                },
              });
              createdWorkspaceId = workspace.workspaceId;
              workspaceRootPath = workspace.rootPath;
            }

            const environmentProvider = platform.getAdapter<IEnvironmentProvider>('environment');
            if (!environmentProvider?.reserve || !environmentProvider?.start) {
              throw new Error(
                'mode=container requires an environment adapter with reserve()/start() support ' +
                '(e.g. @kb-labs/adapters-environment-docker).'
              );
            }

            const reservation = await environmentProvider.reserve({
              namespace,
              runId: provisioningRunId,
              metadata: {
                source: 'auto-provision',
                executionId: request.executionId,
              },
            });

            await environmentProvider.start(reservation.environmentId, {
              workspacePath: workspaceRootPath ?? cwd,
              metadata: {
                source: 'auto-provision',
                executionId: request.executionId,
                namespaceId: namespace,
              },
            });

            if (createdWorkspaceId && workspaceProvider?.attach) {
              await workspaceProvider.attach({
                workspaceId: createdWorkspaceId,
                environmentId: reservation.environmentId,
              });
            }

            platform.logger.debug('Auto-provisioned execution environment', {
              environmentId: reservation.environmentId,
              namespace,
              workspaceId: createdWorkspaceId,
              executionId: request.executionId,
            });

            return {
              environmentId: reservation.environmentId,
              namespace,
              cleanup: async () => {
                if (createdWorkspaceId && workspaceProvider) {
                  try {
                    await workspaceProvider.release(createdWorkspaceId, reservation.environmentId);
                  } catch { /* best-effort */ }
                }
                try {
                  await environmentProvider.destroy(reservation.environmentId, 'auto-provision.done');
                } catch { /* best-effort */ }
              },
            };
          },
        };

        const backend = createIsolatedExecutionBackend({
          localBackend: { platform, uiProvider },
          strictIsolation,
        });

        platform.initExecutionBackend(backend);

        platform.logger.info('ExecutionBackend initialized: container mode via Gateway', {
          dispatchUrl: containerCfg.gatewayDispatchUrl,
        });
      } else if (execution.workspaceAgent?.enabled && execution.workspaceAgent.gatewayUrl) {
        // ── Standard mode + Workspace Agent routing ──
        // Local backend (in-process/worker-pool) with workspace-agent dispatch via Gateway.
        const { createIsolatedExecutionBackend } = await import('@kb-labs/plugin-execution-factory');
        const { GatewayHostResolver, GatewayDispatchTransport } = await import('@kb-labs/gateway-core');

        const agentCfg = execution.workspaceAgent;
        const hostResolver = new GatewayHostResolver({
          gatewayUrl: agentCfg.gatewayUrl,
          internalSecret: agentCfg.internalSecret,
        });

        const strictIsolation = {
          // Container transport (unused here, but required by interface)
          buildTransport(ctx: { runtimeHostId: string; namespaceId: string }) {
            return new GatewayDispatchTransport({
              dispatchEndpoint: `${agentCfg.gatewayUrl}/internal/dispatch`,
              internalSecret: agentCfg.internalSecret,
              runtimeHostId: ctx.runtimeHostId,
              namespaceId: ctx.namespaceId,
            });
          },
          hostResolver,
          buildTransportForHost(hostId: string, namespaceId: string) {
            return new GatewayDispatchTransport({
              dispatchEndpoint: `${agentCfg.gatewayUrl}/internal/dispatch`,
              internalSecret: agentCfg.internalSecret,
              runtimeHostId: hostId,
              namespaceId,
            });
          },
          fallbackPolicy: agentCfg.fallback ?? 'local' as const,
        };

        const backend = createIsolatedExecutionBackend({
          localBackend: {
            platform,
            mode: (execution.mode ?? 'auto') as 'auto' | 'in-process' | 'subprocess' | 'worker-pool',
            uiProvider,
            workerPool: execution.workerPool ? {
              min: execution.workerPool.min,
              max: execution.workerPool.max,
              maxRequestsPerWorker: execution.workerPool.maxRequestsPerWorker,
              maxUptimeMsPerWorker: execution.workerPool.maxUptimeMsPerWorker,
              maxConcurrentPerPlugin: execution.workerPool.maxConcurrentPerPlugin,
            } : undefined,
          },
          strictIsolation,
        });

        platform.initExecutionBackend(backend);

        platform.logger.info('ExecutionBackend initialized: workspace-agent routing via Gateway', {
          gatewayUrl: agentCfg.gatewayUrl,
          fallback: agentCfg.fallback ?? 'local',
        });
      } else {
        // ── Standard mode: in-process | worker-pool ──
        const { createExecutionBackend } = await import('@kb-labs/plugin-execution-factory');

        const factoryMode = (execution.mode ?? 'auto') as 'auto' | 'in-process' | 'subprocess' | 'worker-pool';
        const executionBackend = createExecutionBackend({
          platform: platform,
          mode: factoryMode,
          uiProvider,
          workerPool: execution.workerPool ? {
            min: execution.workerPool.min,
            max: execution.workerPool.max,
            maxRequestsPerWorker: execution.workerPool.maxRequestsPerWorker,
            maxUptimeMsPerWorker: execution.workerPool.maxUptimeMsPerWorker,
            maxConcurrentPerPlugin: execution.workerPool.maxConcurrentPerPlugin,
            warmup: execution.workerPool.warmup ? {
              mode: execution.workerPool.warmup.mode ?? 'none',
              topN: execution.workerPool.warmup.topN,
              maxHandlers: execution.workerPool.warmup.maxHandlers,
            } : undefined,
          } : undefined,
        });

        platform.initExecutionBackend(executionBackend);

        platform.logger.debug('initPlatform initialized ExecutionBackend', {
          mode: factoryMode,
          hasWorkerPool: !!execution.workerPool,
        });
      }
    } catch (error) {
      // In test environment, @kb-labs/plugin-execution may not be available
      // Only warn if in test environment (NODE_ENV=test or vitest detected)
      const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

      if (isTestEnv) {
        platform.logger.warn('ExecutionBackend initialization failed in test environment', {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        // In production/development, ExecutionBackend is REQUIRED
        platform.logger.error('ExecutionBackend initialization failed');
        throw error;
      }
    }

    // Initialize capability services (workspace/snapshot managers)
    try {
      const workspaceManager = new WorkspaceManager(platform);
      const snapshotManager = new SnapshotManager(platform);
      platform.initCapabilityServices(workspaceManager, snapshotManager);
      platform.registerLifecycleHooks('capability-managers', {
        onShutdown: async () => {
          await workspaceManager.shutdown();
          await snapshotManager.shutdown();
        },
      });

      platform.logger.debug('initPlatform initialized capability services', {
        hasWorkspaceProvider: workspaceManager.hasProvider(),
        hasSnapshotProvider: snapshotManager.hasProvider(),
      });
    } catch (error) {
      platform.logger.warn('Failed to initialize capability services, continuing without them', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Initialize orchestration services (environment manager + run executor/orchestrator)
    try {
      if (platform.hasExecutionBackend) {
        const environmentOptions = (adapterOptions.environment ?? {}) as Record<string, unknown>;
        const environmentManager = new EnvironmentManager(platform, {
          janitorIntervalMs: typeof environmentOptions.janitorIntervalMs === 'number'
            ? environmentOptions.janitorIntervalMs
            : undefined,
          janitorBatchSize: typeof environmentOptions.janitorBatchSize === 'number'
            ? environmentOptions.janitorBatchSize
            : undefined,
        });
        const runExecutor = new RunExecutor(platform.executionBackend, platform.logger);
        const runOrchestrator = new RunOrchestrator(
          environmentManager,
          runExecutor,
          platform.logger
        );

        platform.initOrchestrationServices(
          environmentManager,
          runExecutor,
          runOrchestrator
        );
        environmentManager.startJanitor();
        platform.registerLifecycleHooks('environment-manager', {
          onShutdown: async () => {
            await environmentManager.shutdown();
          },
        });

        platform.logger.debug('initPlatform initialized orchestration services', {
          hasEnvironmentProvider: environmentManager.hasProvider(),
        });
      }
    } catch (error) {
      platform.logger.warn('Failed to initialize orchestration services, continuing without them', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Initialize core features (gracefully degrade if workflow unavailable)
    try {
      const coreFeatures = initializeCoreFeatures(platform, core);
      platform.initCoreFeatures(
        coreFeatures.workflows,
        coreFeatures.jobs,
        coreFeatures.cron,
        coreFeatures.resources
      );
      platform.logger.debug('initPlatform initialized core features');
    } catch (error) {
      platform.logger.warn('Failed to initialize core features, continuing without them', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Initialize ResourceBroker for queue and rate limiting (optional)
    let _assemblyBroker: IResourceBroker | undefined;
    try {
      const resourceBroker = initializeResourceBroker(platform, core.resourceBroker);
      platform.initResourceBroker(resourceBroker);
      _assemblyBroker = resourceBroker;
      platform.logger.debug('initPlatform initialized ResourceBroker');
    } catch (error) {
      platform.logger.warn('Failed to initialize ResourceBroker, continuing without rate limiting', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // ExecutionBackend is created before the ResourceBroker so the backend can
    // be selected during platform startup. Re-run the host executor admission
    // wiring after the broker is ready; otherwise in-process CLI executions
    // would expose ctx.api.shell without a broker-backed executor.
    if (_assemblyBroker && !platform.processExecutor) {
      try {
        const { ensureHostProcessExecutor } = await import('@kb-labs/plugin-execution-factory');
        ensureHostProcessExecutor(platform);
      } catch (error) {
        platform.logger.warn('Failed to initialize governed process executor', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (assemblyHook && _assemblyBroker) {
      // ── Hook path: delegate adapter assembly to the caller (e.g. cli/bin) ──────────
      // adapterLoader closes over loadModule() which is internal to initPlatform.
      // It is built here and passed through adapterConfig so the hook (which calls
      // assemblePlatform from @kb-labs/plugin-runtime) can include it in LLMRouterConfig.
      const llmOptions = (adapterOptions.llm ?? {}) as LLMAdapterOptions;
      const executionDefaults = llmOptions.executionDefaults;

      // Apply defaultExecutionPolicy to raw LLM before analytics wrapping.
      // Analytics will track calls that already have defaults merged — correct behaviour.
      if (platform.isReal('llm')) {
        const withDefaults = createDefaultExecutionPolicyLLM(platform.llm, executionDefaults);
        if (withDefaults !== platform.llm) {
          platform.setAdapter('llm', withDefaults);
          platform.logger.debug('initPlatform applied centralized LLM execution defaults (hook path)');
        }
      }

      // adapterLoader must stay here — it captures loadModule + platform + executionDefaults.
      const adapterLoader = async (adapterPackage: string): Promise<ILLM> => {
        try {
          const module = await loadModule(adapterPackage);
          const rawLoaded = await module.createAdapter(llmOptions, {}) as unknown as ILLM;
          const analytics = platform.analytics;
          const withAnalytics =
            analytics && analytics.constructor.name !== 'NoOpAnalytics'
              ? new AnalyticsLLM(rawLoaded, analytics)
              : rawLoaded;
          return createDefaultExecutionPolicyLLM(withAnalytics, executionDefaults);
        } catch (error) {
          platform.logger.warn(`Failed to load adapter ${adapterPackage}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };

      // Build per-adapter config passed to assemblePlatform via hook.
      const platformAssemblyConfig: Partial<Record<string, unknown>> = {};
      if (platform.isReal('llm')) {
        platformAssemblyConfig.llm = {
          defaultTier: llmOptions.defaultTier ?? llmOptions.tier ?? 'small',
          tierMapping: llmOptions.tierMapping,
          capabilities: llmOptions.capabilities,
          adapterLoader,
          logger: platform.logger,
          _privacy: core.privacy?.enabled !== false
            ? (core.privacy ?? { enabled: true })
            : undefined,
        };
      }

      const assembled = assemblyHook(platform, _assemblyBroker, platformAssemblyConfig);

      // Apply assembled adapters back into the platform container.
      for (const key of Object.keys(assembled)) {
        const val = assembled[key];
        if (val !== undefined) {
          platform.setAdapter(key, val as never);
        }
      }

      platform.logger.debug('initPlatform assembly via hook complete', {
        assembledKeys: Object.keys(assembled).filter((k) => assembled[k] !== undefined),
      });
      platform.markAssembled();
    }

    if (!platform.isAssembled && platform.isReal('llm')) {
      throw new Error(
        '[platform] Real LLM adapter is configured but assembly was not applied. ' +
        'Pass assemblyHook: makeAssemblyHook() to launchPlatform() or runService(). ' +
        'Without assembly: no rate limiting, no analytics, no LLM router, no PII redaction.',
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // Notifier adapter — dynamic import to avoid circular dep (adapters/* → core)
    // Channels are resolved here (composition root) so the router stays
    // decoupled from specific channel implementations.
    // ══════════════════════════════════════════════════════════════════════
    if (typeof adapters.notifier === 'string') {
      const notifierOptions = (adapterOptions.notifier ?? {}) as NotifierAdapterOptions;
      try {
        // Built-in type → package map. Extend here as new channel types are added.
        const channelTypePackages: Record<string, string> = {
          telegram: '@kb-labs/adapters-telegram',
        };

        // Resolve and instantiate each channel by type.
        const channels: Record<string, import('@kb-labs/core-platform').INotifierChannel> = {};
        for (const [id, channelCfg] of Object.entries(notifierOptions.channels ?? {})) {
          const pkg = channelTypePackages[channelCfg.type];
          if (!pkg) {
            platform.logger.warn('initPlatform: unknown notifier channel type, skipping', {
              channelId: id,
              type: channelCfg.type,
            });
            continue;
          }
          try {
            const channelModule = await import(pkg);
            const channelFactory = channelModule.createChannel ?? channelModule.default;
            if (typeof channelFactory === 'function') {
              channels[id] = channelFactory(channelCfg, id);
            } else {
              platform.logger.warn('initPlatform: channel package has no createChannel export', { pkg, channelId: id });
            }
          } catch (channelErr) {
            platform.logger.warn('initPlatform: failed to load notifier channel', {
              pkg,
              channelId: id,
              error: channelErr instanceof Error ? channelErr.message : String(channelErr),
            });
          }
        }

        const notifierPkg = adapters.notifier;
        const notifierModule = await import(notifierPkg);
        const notifierFactory = notifierModule.createAdapter ?? notifierModule.default;
        if (typeof notifierFactory === 'function') {
          const notifier = notifierFactory(notifierOptions, {
            eventBus: platform.eventBus,
            broker: platform.resourceBroker,
            logger: platform.logger,
            channels,
          });
          platform.setAdapter('notifier', notifier);
          platform.logger.info('initPlatform initialized notifier adapter', {
            pkg: notifierPkg,
            channels: Object.keys(channels),
          });
        } else {
          platform.logger.warn('Notifier adapter has no createAdapter export', { pkg: adapters.notifier });
        }
      } catch (err) {
        platform.logger.warn('Failed to load notifier adapter', {
          pkg: adapters.notifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Store raw middleware declarations for execution backends to resolve at plugin run time
    if (rawMiddlewareDecls.length > 0) {
      platform.setAdapter('_middlewareDecls', rawMiddlewareDecls);
      platform.logger.debug('initPlatform stored adapter middleware declarations', {
        count: rawMiddlewareDecls.length,
      });
    }

    // Start Unix Socket server to handle adapter calls from children (critical for V3 plugins)
    try {
      const { createUnixSocketServer } = await import('./ipc/unix-socket-server.js');
      const socketServer = await createUnixSocketServer(platform);
      platform.initSocketServer(socketServer);
      platform.logger.debug('initPlatform started Unix Socket server for child processes');
    } catch (error) {
      platform.logger.warn('Failed to start UnixSocketServer, V3 plugin execution will be unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

      platform.logger.debug('initPlatform parent process initialization complete');
    }

    await platform.emitLifecyclePhase('ready', {
      cwd,
      isChildProcess,
      metadata: {
        adapterKeys: platform.listAdapters(),
        durationMs: Date.now() - initStartedAt,
        pid: process.pid,
      },
    });

    return platform;
  } catch (error) {
    await platform.emitLifecycleError(error, 'start', {
      cwd,
      isChildProcess,
      metadata: {
        adapterKeys: Object.keys(adapters),
        durationMs: Date.now() - initStartedAt,
        pid: process.pid,
      },
    });
    throw error;
  }
}

/**
 * Reset the platform to initial state (for testing).
 * Clears all adapters and core features.
 * Platform will use NoOp fallbacks until re-initialized.
 *
 * @example
 * ```typescript
 * // Before test
 * resetPlatform();
 * await initPlatform({ adapters: { llm: mockLLM } });
 *
 * // After test
 * resetPlatform();
 * ```
 */
export function resetPlatform(): void {
  platform.reset();
  resetAdapterStatus();
  // Re-seed InMemory/NoOp fallbacks so the container is usable immediately
  // after reset — tests that call resetPlatform() without initPlatform() get
  // a consistent default state (same as initPlatform with no adapters configured).
  fillAdapterFallbacksAndRecord(platform, {});
}
