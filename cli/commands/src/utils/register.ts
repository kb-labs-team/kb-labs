import { registry } from "../registry/service";
import type { RegisteredCommand } from "../registry/types";
import {
  infoGroup,
  registryGroup,
  docsGroup,
  logsGroup,
  authGroup,
  platformGroup,
  webhookGroup,
  configGroup,
  projectGroup,
} from "../commands/system/groups";
import { createCompletionCommand, autoUpdateCompletion } from "../commands/system/completion";
import { diag } from "../commands/system/diag";
import { registerManifests, disposeAllPlugins, preflightManifests } from "../registry/register";
import { registerShutdownHook } from "./shutdown";
import { getContextCwd } from "@kb-labs/shared-cli-ui";
import type { ILogger } from "@kb-labs/core-platform";
import { platform } from "@kb-labs/core-runtime";

let _registered = false;
const registeredCommands: unknown[] = [];

export interface RegisterBuiltinCommandsInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: ILogger;
  /**
   * Where the KB Labs platform is installed (parent of
   * `node_modules/@kb-labs/*`). Forwarded to `discoverManifests` so that
   * plugin discovery scans the platform `node_modules` regardless of where
   * the CLI is invoked from. When omitted, falls back to `cwd` — this keeps
   * dev-mode behavior unchanged.
   */
  platformRoot?: string;
  /**
   * The user's project root (directory containing `.kb/kb.config.{json,jsonc}`).
   * Discovery uses this to pick up project-scope plugins from
   * `<projectRoot>/.kb/plugins/` and to invalidate the cache when the
   * project's `marketplace.lock` changes. When omitted, falls back to `cwd`.
   */
  projectRoot?: string;
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function registerBuiltinCommands(
  input: RegisterBuiltinCommandsInput = {},
) {
  const log = input.logger ?? platform.logger;

  if (_registered) {
    return;
  }
  _registered = true;
  registry.setLogger(log);
  registry.markPartial(true);
  registeredCommands.length = 0;

  // Register system command groups (migrated commands)
  registry.registerGroup(infoGroup);
  registry.registerGroup(registryGroup);
  registry.registerGroup(docsGroup);
  registry.registerGroup(logsGroup);
  registry.registerGroup(authGroup);
  registry.registerGroup(platformGroup);
  registry.registerGroup(webhookGroup);
  registry.registerGroup(configGroup);
  registry.registerGroup(projectGroup);

  // Standalone system commands
  registry.register(createCompletionCommand(registry));
  registry.register(diag);

  try {
    const cwd = getContextCwd({ cwd: input.cwd });
    const env = input.env ?? process.env;
    const noCache =
      process.argv.includes("--no-cache") || env.KB_PLUGIN_NO_CACHE === "1";
    const { discoverManifests } = await import('../registry/discover');
    const discovered = await discoverManifests(cwd, noCache, {
      platformRoot: input.platformRoot,
      projectRoot: input.projectRoot,
    });

    if (discovered.length > 0) {
      log.info(`Discovered ${discovered.length} packages with CLI manifests`);
      const { valid: readyToRegister, skipped: preflightSkipped } = preflightManifests(discovered, log);

      if (preflightSkipped.length > 0) {
        log.warn(`Preflight skipped ${preflightSkipped.length} manifest(s) during validation`);
        for (const skipped of preflightSkipped) {
          log.warn(`  • ${skipped.id} [${skipped.source}] → ${skipped.reason}`);
        }
      }

      if (readyToRegister.length === 0) {
        log.error('All discovered manifests were skipped during preflight validation');
        registry.markPartial(true);
        _registered = false;
        return;
      }

      const result = await registerManifests(readyToRegister, registry, {
        cwd,
        logger: log,
      });
      if (result.registered.length > 0) {
        log.info(`Registered ${result.registered.length} commands from manifests`);
        registeredCommands.push(...result.registered);
      }
      if (result.skipped.length > 0) {
        for (const skipped of result.skipped) {
          log.error(`Skipped manifest ${skipped.id} from ${skipped.source}: ${skipped.reason}`);
        }
      }
      if (result.skipped.length > 0 || preflightSkipped.length > 0) {
        registry.markPartial(true);
      } else {
        registry.markPartial(false);
      }
    } else {
      registry.markPartial(false);
    }

  } catch (err: unknown) {
    log.warn(`Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    registry.markPartial(true);
    _registered = false;
    return;
  }

  // Regenerate static shell completions if command set changed — cheap check (<1ms typical)
  await autoUpdateCompletion(registry).catch(() => { /* best-effort, never fail startup */ });

  registerShutdownHook(async () => {
    await disposeAllPlugins(registry, log);
  });
}

export function checkSelfUpdateNotices(registered: RegisteredCommand[]): void {
  const currentCliVersion = process.env.CLI_VERSION || '0.1.0';
  
  for (const cmd of registered) {
    const required = cmd.manifest.engine?.kbCli;
    if (!required || !currentCliVersion) {continue;}
    
    if (required.startsWith('^')) {
      const requiredVersion = required.replace('^', '').trim();
      const requiredMajor = parseInt(requiredVersion.split('.')[0] || '0');
      const currentMajor = parseInt(currentCliVersion.split('.')[0] || '0');
      
      if (currentMajor < requiredMajor) {
        console.warn(`[kb-cli] Plugin ${cmd.manifest.package || cmd.manifest.group} requires kb-cli ${required}, found ${currentCliVersion}`);
        console.warn(`[kb-cli]   → Upgrade CLI: pnpm -w update @kb-labs/cli`);
      }
    }
  }
}
