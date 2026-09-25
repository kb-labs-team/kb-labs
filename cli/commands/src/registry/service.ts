/**
 * @kb-labs/cli-commands/registry/service
 * TrieBackedRegistry — path-based CLI command registry (ADR-0015, ADR-0018)
 *
 * Replaces InMemoryRegistry + all legacy flat-map methods.
 * System commands (in-process) always take priority over plugin commands.
 * Plugin namespace ownership: 1 manifest = 1 namespace (ADR-0018).
 */

import type { ILogger } from '@kb-labs/core-platform';
import type { RegisteredCommand } from './types';
import {
  TrieRouter,
  type RouteResult,
  type RegistryDiagnostics,
} from './trie-router';
import type { Command as SystemCommand, CommandGroup as SystemGroup } from '@kb-labs/shared-command-kit';
import { getArchetypeFlags, schemaFlag } from './archetype-flags.js';
import { checkReservedNamespace } from '@kb-labs/cli-contracts';

// ─── Validation ───────────────────────────────────────────────────────────────
// Reserved namespaces (incl. `_`-prefixed platform names) live in
// @kb-labs/cli-contracts `reserved-namespaces`; see checkReservedNamespace.

/** Maximum allowed path depth for plugin commands. */
const MAX_PATH_DEPTH = 6;

function validateSegments(segs: readonly string[]): string | null {
  if (segs.length === 0) { return 'empty path — segments must not be empty'; }
  if (segs.length > MAX_PATH_DEPTH) { return `path too deep: ${segs.length} segments (max ${MAX_PATH_DEPTH})`; }
  return null;
}

// ─── Noop logger fallback ─────────────────────────────────────────────────────

const noopLogger: ILogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as ILogger;

// ─── Registry ─────────────────────────────────────────────────────────────────

export class TrieBackedRegistry {
  private readonly systemRouter = new TrieRouter();
  private readonly pluginRouter = new TrieRouter();
  private partial = false;
  private logger: ILogger = noopLogger;

  // ─── Logger ────────────────────────────────────────────────────────────────

  setLogger(logger: ILogger): void {
    this.logger = logger;
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  register(cmd: SystemCommand): void {
    this.systemRouter.insertSystemCommand(cmd);
  }

  registerGroup(group: SystemGroup): void {
    this.systemRouter.insertSystemGroup(group);
    // Register group meta for the group path itself
    if (group.subgroups) {
      for (const sub of group.subgroups) {
        this.systemRouter.setGroupDescribe([group.name, sub.name], sub.describe ?? '');
      }
    }
  }

  registerManifest(cmd: RegisteredCommand): void {
    if (cmd.manifest._synthetic) { return; }

    const segs = cmd.manifest.segments;
    const pkg  = cmd.packageName ?? 'unknown';

    // ── Validation ───────────────────────────────────────────────────────────
    const validationError = validateSegments(segs);
    if (validationError) {
      this.logger.warn(`[registry] Plugin "${pkg}" skipped: ${validationError} (path: "${segs.join(' ')}")`);
      cmd.shadowed = true;
      return;
    }

    // ── Reserved namespaces (tiers S/V/F/R/P, 06-command-naming §8) ───────────
    const reserved = checkReservedNamespace(segs[0]!, cmd.packageName);
    if (reserved) {
      this.logger.warn(
        `[registry] Plugin "${pkg}" rejected: command "${segs.join(' ')}" — ${reserved.message}.`
      );
      cmd.shadowed = true;
      return;
    }

    // ── System collision — system always wins ─────────────────────────────────
    const sysResult = this.systemRouter.resolve([...segs]);
    if (sysResult.type === 'system-cmd' || sysResult.type === 'system-group') {
      this.logger.warn(`[registry] Plugin "${pkg}" tried to register "${segs.join(' ')}" but it collides with a system command. Command will be shadowed.`);
      cmd.shadowed = true;
      return;
    }

    // ── Archetype flag injection (opt-in via operationType) ───────────────────
    if (cmd.manifest.operationType) {
      const injected = getArchetypeFlags(cmd.manifest.operationType, cmd.manifest.flags ?? []);
      if (injected.length > 0) {
        cmd.manifest.flags = [...(cmd.manifest.flags ?? []), ...injected];
      }
    }

    // ── --schema flag (all commands with operationType) ───────────────────────
    if (cmd.manifest.operationType && !cmd.manifest.flags?.some(f => f.name === 'schema')) {
      cmd.manifest.flags = [...(cmd.manifest.flags ?? []), schemaFlag];
    }

    // ── Namespace ownership — 1 manifest = 1 namespace (ADR-0018) ─────────────
    const result = this.pluginRouter.insertCommand(segs, cmd);
    if (result.collides) {
      this.logger.warn(
        `[registry] Plugin "${pkg}" tried to register "${segs.join(' ')}" ` +
        `but namespace "${segs[0]!}" is owned by "${result.ownerPackage ?? 'unknown'}". ` +
        `Command will be shadowed.`
      );
      cmd.shadowed = true;
      return;
    }

    // ── Aliases ───────────────────────────────────────────────────────────────
    for (const alias of cmd.manifest.aliases ?? []) {
      const aliasSegs = alias.trim().split(/\s+/).filter(Boolean);
      if (aliasSegs.length === 0) { continue; }

      const aliasValidationError = validateSegments(aliasSegs);
      if (aliasValidationError) {
        this.logger.warn(`[registry] Plugin "${pkg}" alias "${alias}" skipped: ${aliasValidationError}`);
        continue;
      }

      const aliasReserved = checkReservedNamespace(aliasSegs[0]!, cmd.packageName);
      if (aliasReserved) {
        this.logger.warn(`[registry] Plugin "${pkg}" alias "${alias}" skipped: ${aliasReserved.message}.`);
        continue;
      }

      const aliasSysResult = this.systemRouter.resolve([...aliasSegs]);
      if (aliasSysResult.type === 'system-cmd' || aliasSysResult.type === 'system-group') {
        this.logger.warn(`[registry] Plugin "${pkg}" alias "${alias}" collides with a system command and will be skipped.`);
        continue;
      }

      const aliasResult = this.pluginRouter.insertCommand(aliasSegs, cmd);
      if (aliasResult.collides) {
        this.logger.warn(
          `[registry] Plugin "${pkg}" alias "${alias}" conflicts with namespace ` +
          `"${aliasSegs[0]!}" owned by "${aliasResult.ownerPackage ?? 'unknown'}". Alias skipped.`
        );
      }
    }

    // ── groupMeta from ManifestV3 declarations ────────────────────────────────
    const v3 = cmd.manifest.manifestV2;
    if (v3?.cli?.groupMeta) {
      for (const meta of v3.cli.groupMeta) {
        const metaSegs = meta.path.trim().split(/\s+/).filter(Boolean);
        this.pluginRouter.setGroupDescribe(metaSegs, meta.describe);
      }
    }
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  resolve(tokens: string[]): RouteResult {
    if (tokens.length > 0) {
      const sysResult = this.systemRouter.resolve(tokens);
      if (sysResult.type !== 'not-found') {
        return sysResult;
      }
    }
    return this.pluginRouter.resolve(tokens);
  }

  // ─── Tab completion ─────────────────────────────────────────────────────────

  complete(tokens: string[]): string[] {
    const sysCompletions = this.systemRouter.complete(tokens);
    const pluginCompletions = this.pluginRouter.complete(tokens);
    return [...new Set([...sysCompletions, ...pluginCompletions])];
  }

  // ─── Query ──────────────────────────────────────────────────────────────────

  listSystemTopLevel(): Array<{ name: string; describe: string; isGroup: boolean }> {
    return this.systemRouter.listSystemTopLevel();
  }

  getPluginGroupDescribe(segments: string[]): string | undefined {
    return this.pluginRouter.getGroupDescribe(segments);
  }

  listCommands(): RegisteredCommand[] {
    return this.pluginRouter.listAll();
  }

  listCommandsUnder(segments: string[]): RegisteredCommand[] {
    return this.pluginRouter.listUnder(segments);
  }

  getCommandAt(segments: string[]): RegisteredCommand | null {
    return this.pluginRouter.getAt(segments);
  }

  // ─── Partial loading state ─────────────────────────────────────────────────

  markPartial(v: boolean): void {
    this.partial = v;
  }

  isPartial(): boolean {
    return this.partial;
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  getDiagnostics(): RegistryDiagnostics {
    return {
      systemCommandCount: this.systemRouter.listAll().length,
      systemGroupCount: 0,
      pluginCommandCount: this.pluginRouter.listAll().length,
      partialLoad: this.partial,
    };
  }
}

export function createRegistry(): TrieBackedRegistry {
  return new TrieBackedRegistry();
}

/** Global registry singleton — populated by bootstrap before any command runs. */
export const registry = new TrieBackedRegistry();
