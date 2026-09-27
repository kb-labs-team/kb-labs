/**
 * @module @kb-labs/core-discovery/discovery-manager
 * The single discovery pipeline: marketplace locks (platform + project scope)
 * plus workspace development sources, loaded and validated the same way.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { type ManifestV3 } from '@kb-labs/plugin-contracts';
import type {
  DiscoveryResult,
  DiscoveredPlugin,
  DiscoveryFailure,
  DiscoveryOrigin,
  DiscoveryScope,
  DiagnosticEvent,
  MarketplaceEntry,
  EntityKind,
} from './types.js';
import { DiagnosticCollector } from './diagnostics.js';
import { readMarketplaceLock } from './marketplace-lock.js';
import { loadManifestFile } from './manifest-loader.js';
import { computePackageIntegrity } from './integrity.js';
import { findWorkspaceCandidates } from './workspace-source.js';
import { readPluginPolicy, checkPluginPolicy, type PluginPolicy } from './plugin-policy.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  /** Workspace root directory (default: process.cwd()) */
  root?: string;
  /**
   * Platform installation root (e.g. ~/kb-platform).
   * When set and different from root, both scopes are discovered:
   * the platform scope lives at platformRoot, the project scope at root.
   * When unset (or equal to root) there is a single root, reported as platform scope.
   */
  platformRoot?: string;
  /** Timeout for each manifest import in milliseconds (default: 5000) */
  importTimeoutMs?: number;
  /** Whether to verify integrity hashes (default: true) */
  verifyIntegrity?: boolean;
  /**
   * Also treat pnpm workspace packages under each scope root that declare a
   * plugin manifest as discovered plugins (monorepo development). Default: true.
   * A root without `pnpm-workspace.yaml` contributes only its own package.
   */
  workspace?: boolean;
}

/** Shadowing priority within one scope: workspace > linked > node_modules. */
const ORIGIN_PRIORITY: Record<DiscoveryOrigin, number> = {
  workspace: 3,
  linked: 2,
  node_modules: 1,
};

/** Any project-scope plugin outranks any platform-scope one (project overrides platform). */
const PROJECT_SCOPE_BONUS = 10;

interface ScopeRoot {
  scope: DiscoveryScope;
  root: string;
}

/** A place a plugin may live, before its manifest has been loaded. */
interface Candidate {
  /** Lock key, or package name for workspace packages */
  id: string;
  scope: DiscoveryScope;
  origin: DiscoveryOrigin;
  packageRoot: string;
  /** Root the lock entry's resolvedPath is relative to, or the workspace root */
  root: string;
  /** Present for lock-backed candidates */
  entry?: MarketplaceEntry;
  /** package.json name, known up front for workspace packages */
  packageName?: string;
}

interface LoadedPlugin {
  plugin: DiscoveredPlugin;
  manifest: ManifestV3;
}

interface CandidateOutcome {
  events: DiagnosticEvent[];
  loaded?: LoadedPlugin;
  failure?: DiscoveryFailure;
}

// ---------------------------------------------------------------------------
// Discovery Manager
// ---------------------------------------------------------------------------

/**
 * The one discovery pipeline. Finds plugins from:
 *
 *   1. `.kb/marketplace.lock` of each scope (platform and project, ADR-0012);
 *      project wins over platform for the same lock key. Entries installed from
 *      the marketplace are `node_modules` origin, linked ones `linked`.
 *   2. pnpm workspace packages under each scope root (`workspace` origin),
 *      the monorepo development source.
 *
 * Every candidate is loaded the same way (static `dist/manifest.json` when
 * built, compiled module otherwise), validated, integrity-checked when locked,
 * and then shadowed by plugin id: project scope beats platform scope, and inside
 * one scope workspace > linked > node_modules.
 *
 * Nothing else is scanned: a package in `node_modules` that is not in a lock is
 * not a plugin.
 */
export class DiscoveryManager {
  private readonly scopes: ScopeRoot[];
  private readonly importTimeoutMs: number;
  private readonly verifyIntegrity: boolean;
  private readonly workspace: boolean;
  /** plugins.allow/block/linked per scope root, read at the start of discover() */
  private policies = new Map<string, PluginPolicy>();

  constructor(opts: DiscoveryOptions = {}) {
    const root = opts.root ?? process.cwd();
    this.scopes = opts.platformRoot && opts.platformRoot !== root
      ? [{ scope: 'platform', root: opts.platformRoot }, { scope: 'project', root }]
      : [{ scope: 'platform', root }];
    this.importTimeoutMs = opts.importTimeoutMs ?? 5_000;
    this.verifyIntegrity = opts.verifyIntegrity ?? true;
    this.workspace = opts.workspace ?? true;
  }

  /**
   * Run the discovery pipeline:
   *
   *   1. Collect candidates (lock entries of each scope, workspace packages)
   *   2. For each candidate → load manifest → validate → verify integrity
   *   3. Shadow duplicates by plugin id
   *   4. Return aggregated result with diagnostics
   */
  async discover(): Promise<DiscoveryResult> {
    const diag = new DiagnosticCollector();
    this.policies = new Map(
      await Promise.all(this.scopes.map(async ({ root }) => [root, await readPluginPolicy(root)] as const)),
    );
    const candidates = await this.collectCandidates(diag);

    const outcomes = await Promise.all(candidates.map(c => this.processCandidate(c)));

    const winners = new Map<string, LoadedPlugin>();
    const failures: DiscoveryFailure[] = [];
    for (const outcome of outcomes) {
      diag.addAll(outcome.events);
      if (outcome.failure) {failures.push(outcome.failure);}
      if (outcome.loaded) {this.shadow(winners, outcome.loaded, diag);}
    }

    const plugins: DiscoveredPlugin[] = [];
    const manifests = new Map<string, ManifestV3>();
    for (const [id, { plugin, manifest }] of winners) {
      plugins.push(plugin);
      manifests.set(id, manifest);
    }
    return { plugins, manifests, failures, diagnostics: diag.getEvents() };
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  private async collectCandidates(diag: DiagnosticCollector): Promise<Candidate[]> {
    // Lock entries. Project scope is read last so it overwrites a platform entry
    // with the same lock key (project overrides platform).
    const locked = new Map<string, Candidate>();
    for (const { scope, root } of this.scopes) {
      const lock = await readMarketplaceLock(root, diag);
      if (!lock) {continue;}
      for (const [id, entry] of Object.entries(lock.installed)) {
        locked.set(id, {
          id,
          scope,
          origin: entry.source === 'local' ? 'linked' : 'node_modules',
          packageRoot: path.resolve(root, entry.resolvedPath),
          root,
          entry,
        });
      }
    }

    const candidates = [...locked.values()];

    if (this.workspace) {
      for (const { scope, root } of this.scopes) {
        for (const found of await findWorkspaceCandidates(root)) {
          candidates.push({
            id: found.packageName,
            scope,
            origin: 'workspace',
            packageRoot: found.packageRoot,
            root,
            packageName: found.packageName,
          });
        }
      }
    }
    return candidates;
  }

  // -------------------------------------------------------------------------
  // Per-candidate processing
  // -------------------------------------------------------------------------

  // eslint-disable-next-line sonarjs/cognitive-complexity
  private async processCandidate(candidate: Candidate): Promise<CandidateOutcome> {
    const diag = new DiagnosticCollector();
    const { id, entry, packageRoot } = candidate;

    const fail = (reason: DiscoveryFailure['reason'], message: string, manifestPath?: string): CandidateOutcome => ({
      events: diag.getEvents(),
      failure: {
        id,
        packageName: candidate.packageName ?? id,
        packageRoot,
        scope: candidate.scope,
        origin: candidate.origin,
        manifestPath,
        reason,
        message,
      },
    });

    // Skip disabled entries
    if (entry?.enabled === false) {
      diag.info('PLUGIN_DISABLED', `Plugin "${id}" is disabled — skipping`, { pluginId: id });
      return { events: diag.getEvents() };
    }

    // Check the package directory exists
    try {
      await fs.access(packageRoot);
    } catch {
      const message = `Package directory not found: ${packageRoot}`;
      diag.error('PACKAGE_NOT_FOUND', message, {
        pluginId: id,
        filePath: packageRoot,
        remediation: `Run "pnpm install" or "kb marketplace install ${id}" to restore`,
      });
      return fail('package-missing', message);
    }

    // Verify integrity for non-local packages. Local packages change frequently
    // (rebuilds, version bumps) — integrity is updated at install/sync time, not here.
    if (this.verifyIntegrity && entry?.integrity && entry.source !== 'local') {
      const ok = await this.checkIntegrity(packageRoot, entry.integrity, id, diag);
      if (!ok) {
        return fail('integrity', `Integrity mismatch for "${id}"`);
      }
    }

    // Load manifest
    const loaded = await loadManifestFile(packageRoot, diag, this.importTimeoutMs);
    if (!loaded) {
      const events = diag.getEvents();
      if (events.some(e => e.code === 'MANIFEST_NOT_PLUGIN')) {
        return { events }; // another kind of package, not a failure
      }
      const { cause, failedFile } = describeLoadFailure(events, packageRoot);
      return fail('manifest', cause || `No manifest could be loaded from ${packageRoot}`, failedFile);
    }
    const { manifest } = loaded;

    // Validate manifest ID matches expected package ID
    if (entry && manifest.id !== id) {
      diag.warning('MANIFEST_VALIDATION_ERROR',
        `Manifest ID "${manifest.id}" does not match lock entry "${id}"`, {
        pluginId: id,
        filePath: packageRoot,
      });
      // Continue anyway — use the manifest's own ID
    }

    // Governance gate (plugins.allow / plugins.block / plugins.linked) for installed third-party packages
    if (candidate.origin === 'node_modules' && !this.passesPolicy(candidate, loaded.packageName, manifest.id, diag)) {
      return { events: diag.getEvents() };
    }

    // Signature check (info-level, not blocking)
    if (entry && !entry.signature) {
      diag.info('SIGNATURE_MISSING', `Plugin "${manifest.id}" is not signed`, {
        pluginId: manifest.id,
        remediation: 'Publish through the official marketplace to get a platform signature',
      });
    }

    const plugin: DiscoveredPlugin = {
      id: manifest.id,
      version: manifest.version,
      packageRoot,
      packageName: loaded.packageName ?? candidate.packageName ?? manifest.id,
      scope: candidate.scope,
      origin: candidate.origin,
      manifestPath: loaded.manifestPath,
      manifestKind: loaded.kind,
      source: entry
        ? { kind: entry.source, path: entry.resolvedPath }
        : { kind: 'local', path: relativeTo(candidate.root, packageRoot) },
      display: manifest.display
        ? { name: manifest.display.name, description: manifest.display.description }
        : undefined,
      integrity: entry?.integrity,
      signature: entry?.signature,
      provides: extractEntityKinds(manifest),
    };
    return { events: diag.getEvents(), loaded: { plugin, manifest } };
  }

  /** Apply plugins.allow/block/linked; records a diagnostic and returns false when the package is gated out. */
  private passesPolicy(
    candidate: Candidate,
    loadedName: string | undefined,
    manifestId: string,
    diag: DiagnosticCollector,
  ): boolean {
    const packageName = loadedName ?? candidate.packageName ?? manifestId;
    const verdict = checkPluginPolicy(this.policies.get(candidate.root) ?? {}, [candidate.id, manifestId, packageName]);
    if (verdict === 'ok') {return true;}

    const config = `${candidate.root}/.kb/kb.config.json`;
    const blocked = verdict === 'blocked';
    diag.info(blocked ? 'PLUGIN_BLOCKED' : 'PLUGIN_NOT_ALLOWED',
      `Plugin "${packageName}" is ${blocked ? 'blocked by plugins.block' : 'not in plugins.allow'} in ${config}`, {
      pluginId: manifestId,
      entityId: packageName,
      remediation: `${blocked ? 'Remove it from plugins.block' : 'Add it to plugins.allow'} in .kb/kb.config.json`,
    });
    return false;
  }

  /**
   * Keep one plugin per manifest id. Project scope beats platform scope; inside
   * one scope the higher-priority origin wins. A tie keeps the first one found.
   */
  private shadow(
    winners: Map<string, LoadedPlugin>,
    incoming: LoadedPlugin,
    diag: DiagnosticCollector,
  ): void {
    const id = incoming.plugin.id;
    const current = winners.get(id);
    if (!current) {
      winners.set(id, incoming);
      return;
    }

    const rank = (p: DiscoveredPlugin): number =>
      (p.scope === 'project' ? PROJECT_SCOPE_BONUS : 0) + ORIGIN_PRIORITY[p.origin];
    const incomingWins = rank(incoming.plugin) > rank(current.plugin);
    const winner = incomingWins ? incoming.plugin : current.plugin;
    const loser = incomingWins ? current.plugin : incoming.plugin;

    if (winner.scope === loser.scope && winner.origin === loser.origin) {
      diag.warning('ENTITY_CONFLICT', `Duplicate plugin ID "${id}" — skipping later entry`, {
        pluginId: id,
        filePath: loser.packageRoot,
      });
    } else {
      diag.info('ENTITY_CONFLICT',
        `Plugin "${id}" found in ${loser.scope}/${loser.origin} is shadowed by ${winner.scope}/${winner.origin}`, {
        pluginId: id,
        filePath: loser.packageRoot,
      });
    }

    if (incomingWins) {winners.set(id, incoming);}
  }

  /**
   * Verify the SRI integrity hash of a package by hashing its package.json.
   */
  private async checkIntegrity(
    packageRoot: string,
    expected: string,
    pluginId: string,
    diag: DiagnosticCollector,
  ): Promise<boolean> {
    try {
      const computed = await computePackageIntegrity(packageRoot);

      if (computed !== expected) {
        diag.error('INTEGRITY_MISMATCH',
          `Integrity mismatch for "${pluginId}": expected ${expected}, got ${computed}`, {
          pluginId,
          filePath: path.join(packageRoot, 'package.json'),
          remediation: `Re-install: kb marketplace install ${pluginId}`,
        });
        return false;
      }
      return true;
    } catch (err) {
      diag.warning('INTEGRITY_MISMATCH',
        `Could not verify integrity for "${pluginId}": ${(err as Error).message}`, {
        pluginId,
        filePath: packageRoot,
      });
      // Non-blocking — proceed without integrity verification
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Summarise why a manifest could not be loaded: the messages and the file that failed, if any. */
function describeLoadFailure(
  events: DiagnosticEvent[],
  packageRoot: string,
): { cause: string; failedFile: string | undefined } {
  const problems = events.filter(e => e.severity !== 'info');
  // The file that failed to load, as opposed to "no manifest found in the package".
  const failedFile = problems.find(e => e.context?.filePath && e.context.filePath !== packageRoot)?.context?.filePath;
  return { cause: problems.map(e => e.message).join('; '), failedFile };
}

function relativeTo(root: string, target: string): string {
  const rel = path.relative(root, target).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Extract which entity kinds a manifest provides by inspecting its sections.
 */
export function extractEntityKinds(manifest: ManifestV3): EntityKind[] {
  const kinds: EntityKind[] = ['plugin']; // Every manifest is at least a plugin

  if (manifest.cli?.commands?.length)               {kinds.push('cli-command');}
  if (manifest.rest?.routes?.length)                 {kinds.push('rest-route');}
  if (manifest.ws?.channels?.length)                 {kinds.push('ws-channel');}
  if (manifest.workflows?.handlers?.length)          {kinds.push('workflow');}
  if (manifest.webhooks?.handlers?.length)           {kinds.push('webhook');}
  if (manifest.jobs?.handlers?.length)               {kinds.push('job');}
  if (manifest.cron?.schedules?.length)              {kinds.push('cron');}
  if (manifest.studio?.pages?.length)                {kinds.push('studio-widget');}
  if (manifest.studio?.menus?.length)                {kinds.push('studio-menu');}

  return kinds;
}
