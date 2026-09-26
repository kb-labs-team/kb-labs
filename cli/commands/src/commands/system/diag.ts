/**
 * diag command — Unified diagnostics + command-trace tool.
 *
 * Base mode  (`kb diag`):            environment, cache, marketplace overview with
 *                                    per-command unavailability and load failures.
 * Trace mode (`kb diag --command X`): five-stage pipeline trace explaining exactly
 *                                    why a specific command is (or isn't) visible.
 */

import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { generateExamples } from '../../utils/generate-examples';
import { registry } from '../../registry/service';
import { discoverManifests, resetInProcCache, loadConfig } from '../../registry/discover';
import { preflightManifests } from '../../registry/register';
import { manifestCacheReadPath } from '../../registry/manifest-cache-path';
import { validateManifests } from '../../registry/schema';
import { readMarketplaceLock, DiagnosticCollector } from '@kb-labs/core-discovery';
import type { MarketplaceEntry } from '@kb-labs/core-discovery';
import type { DiscoveryResult } from '../../registry/types';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { access as fsAccess, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getContextCwd, safeColors, safeSymbols } from '@kb-labs/shared-cli-ui';

// ── Types ──────────────────────────────────────────────────────────────────────

type DiagDetails = {
  category: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  code?: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

type DiagSummary = {
  total: number;
  ok: number;
  warnings: number;
  errors: number;
};

type DiagResult = CommandResult & {
  diagnostics: DiagDetails[];
  summary: DiagSummary;
};

/** One stage in the command trace pipeline. */
type TraceStage = {
  stage: 'context' | 'registry' | 'discovery' | 'lock' | 'filesystem';
  status: 'ok' | 'warning' | 'error' | 'info';
  code: string;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

/** Full result returned from runTrace(). */
type CommandTraceResult = CommandResult & {
  command: string;
  stages: TraceStage[];
  verdict: { rootCause: string; remediation?: string };
};

/** Mutable context passed through (and enriched by) each stage. */
type TraceCtx = {
  cwd: string;
  segments: string[];
  platformRoot?: string;
  projectRoot?: string;
  registryOk?: boolean;        // set by runRegistryStage when command is confirmed available
  discoveryResult?: DiscoveryResult;
  lockEntry?: [string, MarketplaceEntry];
};

/** Structured error returned by tryLoadManifestForTrace. */
type ManifestLoadError = {
  message: string;
  code: 'NO_EXPORT' | 'WRONG_SCHEMA' | 'VALIDATION_FAILED' | 'LOAD_ERROR';
  foundSchema?: string;
  validationErrors?: Array<{ field: string; message: string }>;
};

type DiagFlags = {
  json: { type: 'boolean'; description?: string };
  command: { type: 'string'; description?: string };
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Map a trace stage to a ChainItem for ctx.ui.chain(). */
function stageToChainItem(stage: TraceStage) {
  const statusMap = {
    ok: 'success',
    error: 'error',
    warning: 'warning',
    info: 'info',
  } as const;
  const sections = [
    { items: [stage.message] as string[] },
    ...(stage.remediation ? [{ header: 'Fix', items: [stage.remediation] as string[] }] : []),
  ];
  return {
    title: stage.stage,
    status: statusMap[stage.status],
    summary: { code: stage.code } as Record<string, string | number | boolean>,
    sections,
  };
}

/** Try to load a manifest and return a structured error — or null if it loads cleanly. */
async function tryLoadManifestForTrace(
  manifestPath: string,
  pkgName: string,
): Promise<ManifestLoadError | null> {
  try {
    const mod = await import(pathToFileURL(manifestPath).href) as { manifest?: unknown; default?: unknown };
    const raw = mod.manifest ?? mod.default;

    if (!raw || typeof raw !== 'object') {
      return {
        code: 'NO_EXPORT',
        message: 'No manifest export — add: export { manifest } or export default manifest',
      };
    }

    const schema = (raw as Record<string, unknown>).schema;
    if (schema !== 'kb.plugin/3') {
      return {
        code: 'WRONG_SCHEMA',
        foundSchema: String(schema ?? 'undefined'),
        message: `schema must be "kb.plugin/3", found "${String(schema ?? 'undefined')}"`,
      };
    }

    const cliCmds = (raw as ManifestV3).cli?.commands ?? [];
    if (!Array.isArray(cliCmds) || cliCmds.length === 0) {
      return {
        code: 'VALIDATION_FAILED',
        message: 'cli.commands is empty — no commands to register',
        validationErrors: [{ field: 'cli.commands', message: 'Must contain at least one command' }],
      };
    }

    // Minimal mapping to CommandManifest for Zod validation
    const mapped = cliCmds.map(cmd => {
      const segments = (cmd.path ?? '').trim().split(/\s+/).filter(Boolean);
      return {
        manifestVersion: '1.0' as const,
        segments,
        id: segments[segments.length - 1] ?? 'unknown',
        group: segments[0] ?? 'unknown',
        describe: cmd.describe ?? '',
        loader: async () => { throw new Error('trace-only'); },
        flags: cmd.flags,
        aliases: cmd.aliases,
        operationType: cmd.operationType,
        package: pkgName,
      };
    });

    const result = validateManifests(mapped);
    if (!result.success) {
      const errors = result.errors.flatMap(e =>
        e.issues.map(i => ({ field: i.path.join('.') || '(root)', message: i.message }))
      );
      return {
        code: 'VALIDATION_FAILED',
        message: `${errors.length} validation error(s)`,
        validationErrors: errors,
      };
    }
    return null; // manifest actually loads fine — synthetic was a transient failure
  } catch (err) {
    return {
      code: 'LOAD_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}


/** True if a discovery result belongs to the top-level command segment. */
function matchesTopSegment(result: DiscoveryResult, topSegment: string): boolean {
  if (result.manifests.some(m => m.group === topSegment)) { return true; }
  const last = result.packageName.split('/').pop() ?? '';
  return last.replace(/-entry$|-cli$/, '') === topSegment;
}

/** Find the marketplace.lock entry for a given command's top segment. */
function findLockEntry(
  installed: Record<string, MarketplaceEntry>,
  topSegment: string,
): [string, MarketplaceEntry] | undefined {
  return Object.entries(installed).find(([key]) => {
    const last = key.split('/').pop() ?? '';
    return last.replace(/-entry$|-cli$/, '') === topSegment || last === topSegment;
  });
}

// ── Stage runners ──────────────────────────────────────────────────────────────

async function runContextStage(ctx: TraceCtx): Promise<TraceStage> {
  return {
    stage: 'context',
    status: 'info',
    code: 'CONTEXT',
    message: `cwd=${ctx.cwd}  KB_PLATFORM_ROOT=${ctx.platformRoot ?? '(not set)'}  KB_PROJECT_ROOT=${ctx.projectRoot ?? '(not set)'}`,
    details: {
      cwd: ctx.cwd,
      platformRoot: ctx.platformRoot ?? null,
      projectRoot: ctx.projectRoot ?? null,
      execPath: process.execPath,
    },
  };
}

async function runRegistryStage(
  ctx: TraceCtx,
): Promise<TraceStage & { enrich?: Partial<TraceCtx> }> {
  const result = registry.resolve(ctx.segments);

  if (result.type === 'command') {
    const cmd = result.command;
    if (cmd.shadowed) {
      const owner = registry.listCommands()
        .find(c => c.manifest.segments[0] === ctx.segments[0] && !c.shadowed)
        ?.packageName;
      return {
        stage: 'registry', status: 'warning', code: 'SHADOWED_BY',
        message: `Command found but shadowed by ${owner ?? 'another package'}`,
        details: { ownerPackage: owner ?? null, shadowedPackage: cmd.packageName ?? null },
      };
    }
    if (!cmd.available) {
      return {
        stage: 'registry', status: 'error', code: 'REQUIRES_MISSING',
        message: cmd.unavailableReason ?? 'Command unavailable',
        remediation: cmd.hint,
        details: { package: cmd.packageName ?? null, source: cmd.source },
      };
    }
    return {
      stage: 'registry', status: 'ok', code: 'REGISTRY_OK',
      message: `Command registered and available`,
      details: { package: cmd.packageName ?? null, source: cmd.source },
      enrich: { registryOk: true },
    };
  }

  if (result.type === 'group') {
    return {
      stage: 'registry', status: 'warning', code: 'GROUP_EXISTS_LEAF_MISSING',
      message: `Group "${ctx.segments[0]}" exists but leaf "${ctx.segments.slice(1).join(' ')}" not found`,
      details: { availableChildren: result.childKeys },
    };
  }

  // not-found — also check if a command with this path is registered but shadowed
  const shadowedMatch = registry.listCommands()
    .find(c => c.manifest.segments.join(' ') === ctx.segments.join(' ') && c.shadowed);
  if (shadowedMatch) {
    const owner = registry.listCommands()
      .find(c => c.manifest.segments[0] === ctx.segments[0] && !c.shadowed)
      ?.packageName;
    return {
      stage: 'registry', status: 'warning', code: 'SHADOWED_BY',
      message: `Command is shadowed by ${owner ?? 'another package'}`,
      details: { ownerPackage: owner ?? null, shadowedPackage: shadowedMatch.packageName ?? null },
    };
  }

  return {
    stage: 'registry', status: 'info', code: 'REGISTRY_NOT_FOUND',
    message: 'Command not in registry',
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function runDiscoveryStage(
  ctx: TraceCtx,
): Promise<TraceStage & { enrich?: Partial<TraceCtx> }> {
  resetInProcCache();
  const opts = { platformRoot: ctx.platformRoot, projectRoot: ctx.projectRoot };
  const discovered = await discoverManifests(ctx.cwd, true, opts);

  const [topSegment] = ctx.segments;
  const result = discovered.find(r => matchesTopSegment(r, topSegment ?? ''));

  if (!result) {
    const { block: blocklist = [] } = await loadConfig(ctx.cwd);
    const blocked = blocklist.some(b => b === topSegment || b.includes(`/${topSegment ?? ''}`));
    if (blocked) {
      return {
        stage: 'discovery', status: 'error', code: 'PLUGIN_BLOCKLISTED',
        message: `Plugin "${topSegment}" is in plugins.block in .kb/kb.config.json`,
        remediation: 'Remove it from plugins.block in .kb/kb.config.json',
      };
    }
    return {
      stage: 'discovery', status: 'info', code: 'NOT_IN_DISCOVERY',
      message: `No package found for group "${topSegment}" in workspace or node_modules`,
    };
  }

  // Synthetic manifest = manifest failed to load
  if (result.manifests.every(m => m._synthetic)) {
    const distPath = path.join(result.pkgRoot, 'dist');
    const distExists = await fsAccess(distPath).then(() => true).catch(() => false);

    const loadErr = await tryLoadManifestForTrace(result.manifestPath, result.packageName);

    const stageCode =
      loadErr?.code === 'WRONG_SCHEMA' ? 'WRONG_SCHEMA' :
      loadErr?.code === 'VALIDATION_FAILED' ? 'MANIFEST_VALIDATION_FAILED' :
      'MANIFEST_LOAD_FAILED';

    return {
      stage: 'discovery', status: 'error', code: stageCode,
      message: loadErr ? loadErr.message : 'Manifest failed to load (timeout or import error)',
      remediation: !distExists
        ? `pnpm --filter ${result.packageName} build`
        : 'Fix the error in your manifest.ts',
      details: {
        manifestPath: result.manifestPath,
        distExists,
        error: loadErr?.message ?? null,
        foundSchema: loadErr?.foundSchema ?? null,
        validationErrors: loadErr?.validationErrors ?? null,
      },
      enrich: { discoveryResult: result },
    };
  }

  // Non-synthetic — run structural preflight
  const { skipped } = preflightManifests([result]);
  if (skipped.length > 0) {
    return {
      stage: 'discovery', status: 'error', code: 'MANIFEST_STRUCT_INVALID',
      message: `Manifest loaded but ${skipped.length} command(s) failed structural validation`,
      remediation: 'Fix the errors in your manifest.ts',
      details: {
        failures: skipped.map(s => ({ command: s.id, reason: s.reason })),
      },
    };
  }

  // Check if our specific command path is defined
  const commandPath = ctx.segments.join(' ');
  const found = result.manifests
    .filter(m => !m._synthetic)
    .find(m => m.segments.join(' ') === commandPath);

  if (!found) {
    const availablePaths = result.manifests
      .filter(m => !m._synthetic)
      .map(m => m.segments.join(' '))
      .sort();
    return {
      stage: 'discovery', status: 'warning', code: 'COMMAND_PATH_MISSING',
      message: `Package found but command path "${commandPath}" is not defined in manifest`,
      remediation: `Check command path in manifest.ts. Available (${availablePaths.length}): ${availablePaths.slice(0, 5).join(', ')}${availablePaths.length > 5 ? ` … and ${availablePaths.length - 5} more` : ''}`,
      details: { availablePaths, packageName: result.packageName },
    };
  }

  return {
    stage: 'discovery', status: 'ok', code: 'MANIFEST_OK',
    message: `Manifest loaded and command "${commandPath}" is defined`,
    details: { manifestPath: result.manifestPath, packageName: result.packageName },
    enrich: { discoveryResult: result },
  };
}

async function runLockStage(
  ctx: TraceCtx,
): Promise<TraceStage & { enrich?: Partial<TraceCtx> }> {
  const collector = new DiagnosticCollector();
  const lock = await readMarketplaceLock(ctx.cwd, collector);

  if (!lock) {
    // Registry already confirmed the command — no lock is fine for workspace plugins
    const status = ctx.registryOk ? 'info' : 'warning';
    return {
      stage: 'lock', status, code: 'NO_LOCK',
      message: ctx.registryOk
        ? 'No marketplace.lock — plugin is available from workspace (normal in dev mode)'
        : 'No marketplace.lock found — plugin may not be installed',
    };
  }

  const [topSegment] = ctx.segments;
  const entry = findLockEntry(lock.installed, topSegment ?? '');

  if (!entry) {
    // Command already confirmed available from registry — not being in the lock is fine
    if (ctx.registryOk) {
      return {
        stage: 'lock', status: 'info', code: 'NOT_IN_MARKETPLACE',
        message: `"${topSegment}" is not installed via marketplace — it runs from the workspace (normal in dev mode)`,
      };
    }
    return {
      stage: 'lock', status: 'warning', code: 'NOT_IN_LOCK',
      message: `"${topSegment}" not found in marketplace.lock`,
      remediation: `kb marketplace install ${topSegment}`,
    };
  }

  const [key, data] = entry;
  if (data.enabled === false) {
    return {
      stage: 'lock', status: 'error', code: 'PLUGIN_DISABLED',
      message: `Package "${key}" is installed but disabled`,
      remediation: `kb marketplace plugins enable ${key}`,
      details: { key, version: data.version },
    };
  }

  return {
    stage: 'lock', status: 'ok', code: 'PLUGIN_ENABLED',
    message: `"${key}" is installed and enabled`,
    details: { key, version: data.version, resolvedPath: data.resolvedPath },
    enrich: { lockEntry: entry },
  };
}

async function runFilesystemStage(
  ctx: TraceCtx,
): Promise<TraceStage> {
  if (!ctx.lockEntry) {
    return {
      stage: 'filesystem', status: 'info', code: 'FS_SKIP',
      message: 'Skipped — no lock entry to verify',
    };
  }

  const [, data] = ctx.lockEntry;
  if (!data.resolvedPath) {
    return {
      stage: 'filesystem', status: 'info', code: 'FS_NO_PATH',
      message: 'Lock entry has no resolvedPath to check',
    };
  }

  try {
    await fsAccess(data.resolvedPath);
    return {
      stage: 'filesystem', status: 'ok', code: 'PATH_EXISTS',
      message: `Package path exists at ${data.resolvedPath}`,
    };
  } catch {
    return {
      stage: 'filesystem', status: 'error', code: 'PATH_MISSING',
      message: `Package path does not exist: ${data.resolvedPath}`,
      remediation: 'pnpm install',
      details: { resolvedPath: data.resolvedPath },
    };
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

const STAGE_RUNNERS = [
  runContextStage,
  runRegistryStage,
  runDiscoveryStage,
  runLockStage,
  runFilesystemStage,
];

async function runTrace(ctx: TraceCtx): Promise<CommandTraceResult> {
  const stages: TraceStage[] = [];

  for (const run of STAGE_RUNNERS) {
    const { enrich, ...stage } = await run(ctx) as TraceStage & { enrich?: Partial<TraceCtx> };
    stages.push(stage);
    if (enrich) { Object.assign(ctx, enrich); }
  }

  const failing =
    stages.find(s => s.status === 'error') ??
    stages.find(s => s.status === 'warning');

  const result = {
    command: ctx.segments.join(' '),
    stages,
    verdict: failing
      ? { rootCause: failing.code, remediation: failing.remediation }
      : { rootCause: 'NONE' },
  };

  return failing
    ? { ok: false, error: failing.message, ...result }
    : { ok: true, ...result };
}

// ── Command ────────────────────────────────────────────────────────────────────

export const diag = defineSystemCommand<DiagFlags, DiagResult | CommandTraceResult>({
  name: 'diag',
  description: 'Comprehensive system diagnostics (plugins, cache, environment, versions)',
  category: 'info',
  examples: generateExamples('diag', 'kb', [
    { flags: {} },
    { flags: { json: true } },
    { flags: { command: 'workflow run' } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
    command: { type: 'string', description: 'Trace a specific command through the discovery pipeline (e.g. "workflow run")' },
  },
  analytics: {
    command: 'diag',
    startEvent: 'DIAG_STARTED',
    finishEvent: 'DIAG_FINISHED',
  },
  // eslint-disable-next-line sonarjs/cognitive-complexity
  async handler(ctx, _argv, flags) {
    const cwd = getContextCwd(ctx);
    const platformRoot = process.env.KB_PLATFORM_ROOT;
    const projectRoot = process.env.KB_PROJECT_ROOT;

    // ── Trace mode ─────────────────────────────────────────────────────────────
    if (flags.command) {
      const segments = (flags.command as string).trim().split(/\s+/).filter(Boolean);
      const traceCtx: TraceCtx = { cwd, segments, platformRoot, projectRoot };
      return runTrace(traceCtx);
    }

    // ── Base mode ──────────────────────────────────────────────────────────────
    const diagnostics: DiagDetails[] = [];

    // 1. Environment
    diagnostics.push({
      category: 'environment',
      status: 'ok',
      message: `Node ${process.version}, CLI ${process.env.CLI_VERSION ?? '0.1.0'}, ${process.platform}/${process.arch}`,
      details: {
        nodeVersion: process.version,
        cliVersion: process.env.CLI_VERSION ?? '0.1.0',
        platform: process.platform,
        arch: process.arch,
      },
    });

    // 2. Plugin discovery
    let discovered: DiscoveryResult[] = [];
    try {
      discovered = await discoverManifests(cwd, false, { platformRoot, projectRoot });
      const allCommands = registry.listCommands();
      const enabled = allCommands.filter(m => m.available && !m.shadowed).length;
      const disabled = allCommands.filter(m => !m.available && !m.shadowed).length;
      const shadowed = allCommands.filter(m => m.shadowed).length;

      diagnostics.push({
        category: 'marketplace',
        status: disabled > 0 ? 'warning' : 'ok',
        message: `Found ${discovered.length} packages, ${enabled} enabled, ${disabled} unavailable, ${shadowed} shadowed`,
        details: { packages: discovered.length, enabled, disabled, shadowed, totalCommands: allCommands.length },
      });

      // Per-command unavailability breakdown
      for (const cmd of allCommands.filter(m => !m.available && !m.shadowed)) {
        diagnostics.push({
          category: 'unavailable-command',
          status: 'warning',
          message: `${cmd.manifest.segments.join(' ')}: ${cmd.unavailableReason ?? 'unavailable'}`,
          code: 'REQUIRES_MISSING',
          remediation: cmd.hint,
          details: { source: cmd.source, package: cmd.packageName ?? null },
        });
      }

      // Synthetic manifest failures
      for (const result of discovered) {
        for (const manifest of result.manifests) {
          if (manifest._synthetic) {
            diagnostics.push({
              category: 'manifest-load-failure',
              status: 'error',
              message: `${result.packageName}: manifest failed to load`,
              code: 'MANIFEST_LOAD_FAILED',
              remediation: `pnpm --filter ${result.packageName} build`,
              details: { source: result.source, manifestPath: result.manifestPath },
            });
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        category: 'marketplace',
        status: 'error',
        message: `Discovery failed: ${errMsg}`,
        details: { error: errMsg },
      });
    }

    // 3. Cache
    try {
      const cachePath = manifestCacheReadPath(cwd);
      const cacheExists = await fsAccess(cachePath).then(() => true).catch(() => false);
      if (cacheExists) {
        const cache = JSON.parse(await fsReadFile(cachePath, 'utf8')) as { timestamp?: number; packages?: Record<string, unknown> };
        const ageHours = Math.floor((Date.now() - (cache.timestamp ?? 0)) / (1000 * 60 * 60));
        diagnostics.push({
          category: 'cache',
          status: 'ok',
          message: `Cache exists, ${ageHours}h old, ${Object.keys(cache.packages ?? {}).length} packages cached`,
          details: { exists: true, ageHours, packages: Object.keys(cache.packages ?? {}).length },
        });
      } else {
        diagnostics.push({
          category: 'cache',
          status: 'ok',
          message: 'No cache found (will be created on next discovery)',
          details: { exists: false },
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        category: 'cache',
        status: 'warning',
        message: `Cache check failed: ${errMsg}`,
        details: { error: errMsg },
      });
    }

    // 4. Marketplace lock — also surface DiagnosticCollector events
    try {
      const collector = new DiagnosticCollector();
      const lock = await readMarketplaceLock(cwd, collector);

      for (const event of collector.getEvents()) {
        if (event.severity === 'error' || event.severity === 'warning') {
          diagnostics.push({
            category: 'lock-event',
            status: event.severity === 'error' ? 'error' : 'warning',
            message: event.message,
            code: event.code,
            remediation: event.remediation,
            details: event.context as Record<string, unknown> | undefined,
          });
        }
      }

      if (lock) {
        const entries = Object.entries(lock.installed);
        const enabledCount = entries.filter(([, e]) => e.enabled !== false).length;
        const disabledCount = entries.length - enabledCount;
        diagnostics.push({
          category: 'marketplace-lock',
          status: 'ok',
          message: `${entries.length} installed (${enabledCount} enabled, ${disabledCount} disabled)`,
          details: { total: entries.length, enabled: enabledCount, disabled: disabledCount },
        });
      } else {
        diagnostics.push({
          category: 'marketplace-lock',
          status: 'warning',
          message: 'No marketplace.lock found — no plugins installed via marketplace',
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        category: 'marketplace-lock',
        status: 'error',
        message: `Marketplace lock check failed: ${errMsg}`,
        details: { error: errMsg },
      });
    }

    // 5. Version compatibility
    try {
      const cliVersion = process.env.CLI_VERSION ?? '0.1.0';
      const versionIssues: Array<{ plugin: string; required: string; current: string }> = [];
      for (const cmd of registry.listCommands()) {
        const required = cmd.manifest.engine?.kbCli;
        if (required) {
          const requiredMajor = parseInt(required.replace('^', '').split('.')[0] ?? '0', 10);
          const currentMajor = parseInt(cliVersion.split('.')[0] ?? '0', 10);
          if (!isNaN(requiredMajor) && !isNaN(currentMajor) && currentMajor < requiredMajor) {
            versionIssues.push({ plugin: cmd.manifest.package ?? cmd.manifest.group, required, current: cliVersion });
          }
        }
      }
      diagnostics.push({
        category: 'versions',
        status: versionIssues.length > 0 ? 'warning' : 'ok',
        message: versionIssues.length > 0
          ? `${versionIssues.length} plugin(s) require newer CLI version`
          : 'All plugins compatible with current CLI version',
        details: { issues: versionIssues },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        category: 'versions',
        status: 'error',
        message: `Version check failed: ${errMsg}`,
        details: { error: errMsg },
      });
    }

    const summary: DiagSummary = {
      total: diagnostics.length,
      ok: diagnostics.filter(d => d.status === 'ok').length,
      warnings: diagnostics.filter(d => d.status === 'warning').length,
      errors: diagnostics.filter(d => d.status === 'error').length,
    };

    ctx.platform?.logger?.info('Diag command completed', summary);

    return summary.errors === 0
      ? { ok: true, diagnostics, summary }
      : { ok: false, error: `${summary.errors} diagnostic error(s) found`, diagnostics, summary };
  },

  // eslint-disable-next-line sonarjs/cognitive-complexity
  formatter(result, ctx, flags) {
    if (flags.json) {
      ctx.ui?.json?.(result);
      return;
    }

    // ── Trace mode output ──────────────────────────────────────────────────────
    if ('stages' in result) {
      const trace = result as CommandTraceResult;
      const verdictStatus = trace.ok ? 'success' : 'error' as const;
      const verdictMsg = trace.ok
        ? 'Command is fully operational'
        : `Root cause: ${trace.verdict.rootCause}`;

      ctx.ui.chain([
        ...trace.stages.map(stageToChainItem),
        {
          title: 'verdict',
          status: verdictStatus,
          summary: { rootCause: trace.verdict.rootCause } as Record<string, string | number | boolean>,
          sections: [
            { items: [verdictMsg] as string[] },
            ...(trace.verdict.remediation ? [{ header: 'Fix', items: [trace.verdict.remediation] as string[] }] : []),
          ],
        },
      ]);
      return;
    }

    // ── Base mode output ───────────────────────────────────────────────────────
    const base = result as DiagResult;
    const hasErrors = base.summary.errors > 0;
    const hasWarnings = base.summary.warnings > 0;

    const summaryItems = [
      `${safeColors.bold('Total Checks')}: ${base.summary.total}`,
      `${safeColors.success('OK')}: ${base.summary.ok}`,
      `${safeColors.warning('Warnings')}: ${base.summary.warnings}`,
      `${safeColors.error('Errors')}: ${base.summary.errors}`,
    ];

    const diagItems: string[] = [];
    for (const diag of base.diagnostics) {
      const icon = diag.status === 'ok' ? safeSymbols.success
        : diag.status === 'warning' ? safeSymbols.warning
        : safeSymbols.error;
      const colorize = diag.status === 'ok' ? safeColors.success
        : diag.status === 'warning' ? safeColors.warning
        : safeColors.error;

      diagItems.push(`${icon} ${colorize(safeColors.bold(diag.category))}: ${diag.message}`);

      if (diag.remediation) {
        diagItems.push(`   ${safeColors.muted(`→ Fix: ${diag.remediation}`)}`);
      }

      if (diag.status === 'warning' && Array.isArray(diag.details?.issues)) {
        for (const issue of diag.details.issues as Array<{ plugin: string; required: string; current: string }>) {
          diagItems.push(`   ${safeColors.warning(`→ ${issue.plugin}: requires ${issue.required}, found ${issue.current}`)}`);
        }
      }
    }

    const nextSteps: string[] = [];
    if (hasErrors) { nextSteps.push(`kb marketplace doctor  ${safeColors.muted('Diagnose plugin issues')}`); }
    if (hasWarnings) { nextSteps.push(`kb marketplace list  ${safeColors.muted('List all plugins')}`); }
    nextSteps.push(`kb diag --command <name>  ${safeColors.muted('Trace a specific command')}`);

    const sections = [
      { header: 'Summary', items: summaryItems },
      { header: 'Details', items: diagItems },
      { header: 'Next Steps', items: nextSteps },
    ];

    if (hasErrors) {
      ctx.ui.error('System Diagnostics', { sections });
    } else if (hasWarnings) {
      ctx.ui.warn('System Diagnostics', { sections });
    } else {
      ctx.ui.success('System Diagnostics', { sections });
    }
  },
});
