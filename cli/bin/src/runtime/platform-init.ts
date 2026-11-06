/**
 * Platform initialization for KB Labs CLI.
 *
 * Thin wrapper around `loadPlatformConfig` + `initPlatform` from
 * `@kb-labs/core-runtime`. The shared loader is responsible for resolving
 * `platformRoot` and `projectRoot`, loading the `.env` file, reading both
 * platform defaults and project config, and deep-merging them. This file
 * only adds CLI-specific concerns: the UI provider and lifecycle hooks.
 */

import {
  initPlatform,
  loadPlatformConfig as readPlatformConfig,
  platform,
  requireProjectContext,
  type PlatformContainer,
  type PlatformLifecycleContext,
  type PlatformLifecycleHooks,
  type PlatformLifecyclePhase,
  type LoadPlatformConfigResult,
  isWorkspaceDevelopmentMode,
} from "@kb-labs/core-runtime";
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { noopUI } from "@kb-labs/plugin-contracts";
import type { UIFacade } from "@kb-labs/plugin-contracts";
import { createCLIUIFacade } from "./ui-facade";
import { createContextLogger } from "@kb-labs/core-platform";
import { missingCliResultWriter, type CliResultWriter } from './result-serializer.js';

const CLI_LIFECYCLE_HOOK_ID = "cli-runtime";
const LOG_SERVICE = "platform-init";
let lifecycleHooksRegistered = false;

function lifecycleLogger() {
  return createContextLogger(platform.logger, {
    applicationId: "kb",
    serviceId: "kb",
    instanceId: `${process.pid}`,
    layer: "cli",
  }).forComponent("platform-lifecycle");
}

function ensureLifecycleHooksRegistered(): void {
  if (lifecycleHooksRegistered) {
    return;
  }

  const hooks: PlatformLifecycleHooks = {
    onStart: (ctx: PlatformLifecycleContext) => {
      lifecycleLogger().debug("Platform lifecycle: start", {
        app: "cli",
        cwd: ctx.cwd,
      });
    },
    onReady: (ctx: PlatformLifecycleContext) => {
      lifecycleLogger().debug("Platform lifecycle: ready", {
        app: "cli",
        durationMs: ctx.metadata?.durationMs,
      });
    },
    onShutdown: () => {
      lifecycleLogger().debug("Platform lifecycle: shutdown", { app: "cli" });
    },
    onError: (error: unknown, phase: PlatformLifecyclePhase) => {
      lifecycleLogger().warn("Platform lifecycle hook error", {
        app: "cli",
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };

  platform.registerLifecycleHooks(CLI_LIFECYCLE_HOOK_ID, hooks);
  lifecycleHooksRegistered = true;
}

/**
 * Create CLI-specific UI provider.
 * Returns rich UI for CLI host, noopUI for other hosts (REST, workflow, etc.)
 */
function createCLIUIProvider(writeResult: CliResultWriter): (hostType: string) => UIFacade {
  return (hostType: string): UIFacade => {
    if (hostType !== "cli") {
      return noopUI;
    }
    return createCLIUIFacade(undefined, writeResult);
  };
}

export type PlatformInitResult = LoadPlatformConfigResult & {
  /** The initialized platform singleton. */
  platform: PlatformContainer;
};

/**
 * Read platform or project configuration without constructing adapters.
 *
 * @param cwd        Starting directory for project-root discovery
 *                   (typically `process.cwd()`).
 * @param moduleUrl  `import.meta.url` of the CLI binary — lets us locate
 *                   the platform installation in installed mode without
 *                   guessing `..` levels. Optional in dev mode.
 */
export async function loadPlatformConfiguration(
  cwd: string,
  moduleUrl?: string,
  projectScope: 'required' | 'platform' = 'platform',
  options: { persistCatalogSnapshot?: boolean } = {},
): Promise<LoadPlatformConfigResult> {
  return readPlatformConfig({
    moduleUrl,
    startDir: cwd,
    projectScope,
    executionHealth: () => platform.executionBackend.health(),
    persistCatalogSnapshot: options.persistCatalogSnapshot,
  });
}

/** Initialize the platform's adapters exactly once from an already-resolved scope. */
export async function initializePlatform(
  loadResult: LoadPlatformConfigResult,
  options: { skipAdapterInitialization?: boolean; resultWriter?: CliResultWriter } = {},
): Promise<PlatformInitResult> {
  const {
    platformConfig,
    rawConfig,
    platformRoot,
    projectRoot,
    sources,
  } = loadResult;
  const adapterProjectRoot = loadResult.projectScope === 'platform'
    ? platformRoot
    : requireProjectContext(projectRoot);
  if (options.skipAdapterInitialization) {
    return { ...loadResult, platform };
  }
  ensureLifecycleHooksRegistered();
  const workspaceDevelopment = isWorkspaceDevelopmentMode(loadResult);
  const workspaceRoot = workspaceDevelopment ? projectRoot : undefined;
  const platformInstance = await initPlatform(
      platformConfig,
      adapterProjectRoot,
      createCLIUIProvider(options.resultWriter ?? missingCliResultWriter),
      platformRoot !== adapterProjectRoot ? platformRoot : undefined,
    {
      assemblyHook: makeAssemblyHook(() =>
        process.env.KB_DEBUG === "true" ? platform.logger : undefined,
      ),
      workspaceDevelopment,
      catalog: loadResult.catalog,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    },
  );

  platformInstance.logger.info("Platform adapters initialized", {
    layer: "cli",
    service: LOG_SERVICE,
    platformRoot,
    projectRoot,
    sources,
    adapters: Object.keys(platformConfig.adapters ?? {}),
    hasAdapterOptions: !!platformConfig.adapterOptions,
  });

  if (process.env.KB_DEBUG === "true") {
    platformInstance.logger.debug("kb.diag.config", {
      event: "kb.diag.config",
      v: 1,
      data: {
        platformConfigPath: sources.platformDefaults,
        projectConfigPath: sources.projectConfig,
        overlayPaths: sources.overlays ?? [],
        fieldSources: sources.fields ?? {},
        ignoredProjectFields: sources.ignoredProjectFields ?? [],
      },
      ts: Date.now(),
    });
  }

  return { ...loadResult, platform: platformInstance };
}

/**
 * Resolve the selected project's config and overlays before adapter
 * construction so project-specific default paths use the selected project.
 */
export async function resolveProjectConfig(
  cwd: string,
  moduleUrl?: string,
): Promise<LoadPlatformConfigResult> {
  return loadPlatformConfiguration(cwd, moduleUrl, 'required');
}
