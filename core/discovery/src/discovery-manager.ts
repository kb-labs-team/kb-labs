/**
 * @module @kb-labs/core-discovery/discovery-manager
 * The single discovery pipeline: marketplace locks (platform + project scope)
 * plus workspace development sources, loaded and validated the same way.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CliCommandDeclSchema, resolvePluginBasePath, type ManifestV3 } from '@kb-labs/plugin-contracts';
import { createExtensionStore } from '@kb-labs/core-extension-store';
import type { IExtensionStore } from '@kb-labs/core-extension-store';
import type {
  DiscoveryResult, DiscoveryFailure, DiscoveredPlugin, DiscoveryOrigin, DiscoveryScope, DiagnosticEvent, EntityKind,
  MarketplaceEntry, MarketplaceLock, DiscoveryInput, DiscoveryCandidateMembership,
} from '@kb-labs/plugin-contracts';
import { DiagnosticCollector } from './diagnostics.js';
import { resolveCliHandlerPath } from '@kb-labs/core-platform';
import { describeHandlerAccessFailure } from './handler-access.js';
import { isPortableRelativePath, isUserOwnedLinkPath, readMarketplaceLock } from './marketplace-lock.js';
import { resolveMarketplaceLockScope, type MarketplaceLockRoots } from './marketplace-lock-scope.js';
import { loadManifestFile } from './manifest-loader.js';
import { computePackageIntegrity } from './integrity.js';
import { findWorkspaceCandidates, findWorkspacePackageRoots } from './workspace-source.js';
import { readPluginPolicy, checkPluginPolicy, isFirstPartyPluginSource, type PluginPolicy, type PluginPolicyResult } from './plugin-policy.js';
import { readDiscoveryInputs } from './discovery-inputs.js';

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
  /** Scope assigned when discovering one root without a separate platform root. Defaults to platform. */
  scope?: 'platform' | 'project';
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
  /** Additional workspace roots whose matched packages are selected by another registry source. */
  additionalWorkspaceRoots?: readonly string[];
  /** Machine-local extension store used to resolve project version pins. */
  extensionStore?: IExtensionStore;
  /** Observe root input reads; used to verify discovery and fingerprint inputs stay aligned. */
  onInputRead?: (filePath: string, bytes?: Buffer) => void;
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
  inputs: DiscoveryInput[];
}

interface CandidateOutcome {
  events: DiagnosticEvent[];
  loaded?: LoadedPlugin;
  failure?: DiscoveryFailure;
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function hasFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
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
  private readonly lockRoots: MarketplaceLockRoots;
  private readonly importTimeoutMs: number;
  private readonly verifyIntegrity: boolean;
  private readonly workspace: boolean;
  private readonly additionalWorkspaceRoots: readonly string[];
  private readonly extensionStore: IExtensionStore;
  private readonly onInputRead?: (filePath: string, bytes?: Buffer) => void;
  private consumedInputDigests = new Map<string, string>();
  private marketplaceLocks = new Map<string, MarketplaceLock>();
  private marketplaceLocksLoaded = false;
  /** plugins.allow/block/linked per scope root, read at the start of discover() */
  private policies = new Map<string, PluginPolicyResult>();

  constructor(opts: DiscoveryOptions = {}) {
    const root = opts.root ?? process.cwd();
    this.lockRoots = opts.platformRoot
      ? { platformRoot: opts.platformRoot, projectRoot: root }
      : opts.scope === 'project'
        ? { projectRoot: root }
        : { platformRoot: root };
    this.scopes = opts.platformRoot && opts.platformRoot !== root
      ? [{ scope: 'platform', root: opts.platformRoot }, { scope: 'project', root }]
      : [{ scope: opts.scope ?? 'platform', root }];
    this.importTimeoutMs = opts.importTimeoutMs ?? 5_000;
    this.verifyIntegrity = opts.verifyIntegrity ?? true;
    this.workspace = opts.workspace ?? true;
    this.additionalWorkspaceRoots = [...new Set((opts.additionalWorkspaceRoots ?? []).map(root => path.resolve(root)))];
    this.extensionStore = opts.extensionStore ?? createExtensionStore();
    this.onInputRead = opts.onInputRead;
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
    const roots = this.scopes.map(({ root }) => root);
    const inputRoots = [...new Set([...roots, ...this.additionalWorkspaceRoots])];
    const candidateMemberships: DiscoveryCandidateMembership[] = [];
    this.consumedInputDigests.clear();
    this.marketplaceLocks.clear();
    this.marketplaceLocksLoaded = false;
    const diag = new DiagnosticCollector();
    const policyResults = await Promise.all(this.scopes.map(async ({ scope, root }) => [scope, root, await readPluginPolicy(root, (filePath, bytes) => this.recordInputRead(filePath, bytes))] as const));
    this.policies = new Map(policyResults.map(([, root, result]) => [root, result]));
    for (const [scope, , result] of policyResults) {
      if (result.kind !== 'invalid') continue;
      for (const issue of result.diagnostics) {
        diag.error(issue.code, issue.message, {
          filePath: issue.path ?? result.configPath,
          remediation: `${issue.hint ?? issue.message} Then run \`kb marketplace plugins doctor --scope ${scope}\`.`,
        });
      }
    }
    const candidates = await this.collectCandidates(diag, candidateMemberships);
    for (const root of this.additionalWorkspaceRoots) {
      if (candidateMemberships.some(membership => membership.root === root)) continue;
      candidateMemberships.push({ source: 'workspace', root, packageRoots: await findWorkspacePackageRoots(root) });
    }
    candidateMemberships.sort((left, right) => left.source.localeCompare(right.source) || left.root.localeCompare(right.root));

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
    const manifestInputs = [...winners.values()].flatMap(({ inputs }) => inputs);
    const consumedRootInputs = [...this.consumedInputDigests].map(([inputPath, digest]) => ({ path: inputPath, digest }));
    const { inputs, fingerprint } = await readDiscoveryInputs(inputRoots, [...manifestInputs, ...consumedRootInputs], candidateMemberships);
    return {
      plugins,
      manifests,
      failures,
      diagnostics: diag.getEvents(),
      inputs,
      candidateMemberships,
      fingerprint,
    };
  }

  /** The exact lock objects read for the latest resolved view, keyed by scope root. */
  async getMarketplaceLocks(): Promise<ReadonlyMap<string, MarketplaceLock>> {
    if (!this.marketplaceLocksLoaded) {
      await this.loadMarketplaceLocks(new DiagnosticCollector());
    }
    return this.marketplaceLocks;
  }

  /** Resolve an unmounted REST namespace to the package that declares it in the extension store. */
  async findStoredPluginPackageForRestPrefix(
    requestedPrefix: string,
    basePath: string,
  ): Promise<string | undefined> {
    const entries = await this.extensionStore.listEntries();
    for (const entry of entries) {
      if (entry.kind !== 'plugin' || !entry.manifest) {continue;}
      const rest = entry.manifest.rest;
      if (!rest || (!rest.basePath && !rest.routes?.length)) {continue;}
      const prefix = resolvePluginBasePath(entry.manifest, 'rest', basePath);
      if (prefix === requestedPrefix || prefix.startsWith(`${requestedPrefix}/`)) {
        return entry.name;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  private async collectCandidates(diag: DiagnosticCollector, candidateMemberships: DiscoveryCandidateMembership[]): Promise<Candidate[]> {
    await this.loadMarketplaceLocks(diag);
    // Lock entries. Project scope is read last so it overwrites a platform entry
    // with the same lock key (project overrides platform).
    const locked = new Map<string, Candidate>();
    for (const { scope, root } of this.scopes) {
      const lock = this.marketplaceLocks.get(root);
      if (!lock) {continue;}
      for (const [id, entry] of Object.entries(lock.plugins)) {
        const invalidOwnedPath = entry.source === 'local'
          ? !isUserOwnedLinkPath(entry.link)
          : entry.resolvedPath !== undefined && !isPortableRelativePath(entry.resolvedPath, root);
        if (invalidOwnedPath) {
          diag.error('LOCK_SCHEMA_INVALID', `Marketplace lock entry "${id}" has an invalid path.`, {
            pluginId: id,
            remediation: 'Run "kb marketplace sync" to regenerate .kb/marketplace.lock in schema v3.',
          });
          continue;
        }
        let packageRoot: string | undefined;
        if (entry.source === 'local' && entry.link) {
          packageRoot = path.resolve(root, entry.link);
        } else if (entry.resolvedPath) {
          packageRoot = path.resolve(root, entry.resolvedPath);
        } else if (entry.source === 'marketplace' && entry.version && entry.integrity) {
          try {
            packageRoot = (await this.extensionStore.lookup({ name: entry.package!, version: entry.version, expectedIntegrity: entry.integrity }))?.packageRoot;
          } catch (error) {
            diag.error('INTEGRITY_MISMATCH', `Pinned package ${id}@${entry.version} does not match the shared store: ${error instanceof Error ? error.message : String(error)}`, {
              pluginId: id,
              remediation: `Run "kb marketplace install ${id}@${entry.version}" to restore the pinned version`,
            });
            continue;
          }
        }
        if (!packageRoot) {
          diag.error('PLUGIN_STORE_MISSING', `Pinned package ${id}@${entry.version} is missing from the shared store`, {
            pluginId: id,
            remediation: 'Run "kb marketplace install ' + id + '" to restore the pinned version',
          });
          continue;
        }
        locked.set(id, {
          id,
          scope,
          origin: entry.source === 'local' ? 'linked' : 'node_modules',
          packageRoot,
          root,
          entry,
        });
      }
    }

    const candidates = [...locked.values()];

    if (this.workspace) {
      for (const { scope, root } of this.scopes) {
        for (const found of await findWorkspaceCandidates(
          root,
          (filePath, bytes) => this.recordInputRead(filePath, bytes),
          (packageRoots) => candidateMemberships.push({ source: 'workspace', root: path.resolve(root), packageRoots: [...packageRoots] }),
        )) {
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

  private async loadMarketplaceLocks(diag: DiagnosticCollector): Promise<void> {
    if (this.marketplaceLocksLoaded) return;
    for (const { root } of this.scopes) {
      const lockScope = await resolveMarketplaceLockScope(this.lockRoots, root);
      const lock = await readMarketplaceLock(root, diag, lockScope, (filePath, bytes) => this.recordInputRead(filePath, bytes));
      if (lock) this.marketplaceLocks.set(root, lock);
    }
    this.marketplaceLocksLoaded = true;
  }

  // -------------------------------------------------------------------------
  // Per-candidate processing
  // -------------------------------------------------------------------------

  // eslint-disable-next-line sonarjs/cognitive-complexity
  private async processCandidate(candidate: Candidate): Promise<CandidateOutcome> {
    const diag = new DiagnosticCollector();
    const { id, entry, packageRoot } = candidate;

    const fail = (reason: DiscoveryFailure['reason'], message: string, manifestPath?: string,
                  diagnosticCode?: DiscoveryFailure['diagnosticCode'],
                  remediation?: string): CandidateOutcome => ({
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
        diagnosticCode,
        remediation,
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
    } catch (error) {
      if (!isMissingFile(error)) {
        const message = `Package directory cannot be accessed: ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`;
        diag.error('PACKAGE_UNAVAILABLE', message, {
          pluginId: id,
          filePath: packageRoot,
          remediation: `Check permissions for "${packageRoot}", then run "kb marketplace plugins doctor --scope ${candidate.scope}".`,
        });
        return fail('package-unavailable', message);
      }
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
    if (this.verifyIntegrity && entry?.integrity && entry.source !== 'local' && entry.resolvedPath) {
      const ok = await this.checkIntegrity(packageRoot, entry.integrity, id, diag);
      if (!ok) {
        return fail('integrity', `Integrity mismatch for "${id}"`);
      }
    }

    // A linked workspace package whose declared compiled manifest is absent is
    // known to be unbuilt. Keep it visible with a build diagnostic instead of
    // silently dropping its locked command namespace.
    if (entry?.source === 'local' && entry.link) {
      const packageJsonPath = path.join(packageRoot, 'package.json');
      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
          kb?: { manifest?: string };
        };
        const manifestTarget = packageJson.kb?.manifest;
        const staticManifest = path.join(packageRoot, 'dist', 'manifest.json');
        const hasStaticManifest = await hasFile(staticManifest);
        const hasCompiledManifest = manifestTarget
          ? await hasFile(path.resolve(packageRoot, manifestTarget))
          : false;
        if (manifestTarget && !hasStaticManifest && !hasCompiledManifest) {
          const remediation = 'Run `pnpm build` and retry the command.';
          const message = `Workspace plugin "${id}" is unavailable because its manifest build output is missing.`;
          diag.error('PLUGIN_BUILD_MISSING', message, { pluginId: id, filePath: path.resolve(packageRoot, manifestTarget), remediation });
          return fail('manifest', message, path.resolve(packageRoot, manifestTarget), 'PLUGIN_BUILD_MISSING', remediation);
        }
      } catch (error) {
        if (!isMissingFile(error)) {
          const message = `Package metadata cannot be read: ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`;
          const remediation = `Repair package.json and rebuild the linked package, then run \`kb marketplace plugins doctor --scope ${candidate.scope}\`.`;
          diag.error('MANIFEST_PARSE_ERROR', message, { pluginId: id, filePath: packageJsonPath, remediation });
          return fail('manifest', message, packageJsonPath, 'MANIFEST_PARSE_ERROR', remediation);
        }
      }
    }

    // Load manifest
    const loaded = await loadManifestFile(packageRoot, diag, this.importTimeoutMs);
    if (loaded.kind === 'failed') {
      const events = diag.getEvents();
      if (events.some(e => e.code === 'MANIFEST_NOT_PLUGIN')) {
        if (entry?.primaryKind === 'plugin') {
          const message = `Enabled plugin "${id}" does not contain a plugin manifest.`;
          const remediation = `Install a package that declares a plugin manifest, or remove "${id}" from the marketplace lock.`;
          diag.error('MANIFEST_NOT_PLUGIN', message, { pluginId: id, filePath: packageRoot, remediation });
          return fail('manifest', message, packageRoot, 'MANIFEST_NOT_PLUGIN', remediation);
        }
        return { events }; // another kind of package, not a failure
      }
      const { cause, failedFile } = describeLoadFailure(events, packageRoot);
      return fail('manifest', cause || `No manifest could be loaded from ${packageRoot}`, failedFile);
    }
    if (loaded.kind === 'not-plugin') {
      if (entry?.primaryKind === 'plugin') {
        const message = `Enabled plugin "${id}" does not declare a plugin manifest.`;
        const remediation = `Install a package that declares kb.manifest or kb.plugin.json, or remove "${id}" from the marketplace lock.`;
        diag.error('MANIFEST_NOT_PLUGIN', message, { pluginId: id, filePath: packageRoot, remediation });
        return fail('manifest', message, packageRoot, 'MANIFEST_NOT_PLUGIN', remediation);
      }
      return { events: diag.getEvents() };
    }
    const { manifest } = loaded.loaded;

    // Validate manifest ID matches expected package ID
    if (entry && manifest.id !== id) {
      const message = `Manifest ID "${manifest.id}" does not match lock entry "${id}"`;
      const remediation = 'Correct the manifest id or reinstall the package with its canonical plugin ID.';
      diag.error('PLUGIN_ID_MISMATCH',
        message, {
        pluginId: id,
        filePath: packageRoot,
        remediation,
      });
      return fail('manifest', message, loaded.loaded.manifestPath, 'PLUGIN_ID_MISMATCH', remediation);
    }

    // A present but invalid policy closes the marketplace gate for third-party packages in this scope.
    const policyResult = this.policies.get(candidate.root);
    const resolvedPackageName = loaded.loaded.packageName ?? candidate.packageName ?? manifest.id;
    const provenance = { origin: candidate.origin, scope: candidate.scope, lockSource: entry?.source } as const;
    if (!isFirstPartyPluginSource(provenance) && policyResult?.kind === 'invalid') {
      const issue = policyResult.diagnostics[0]!;
      const message = `Plugin "${resolvedPackageName}" is unavailable: ${issue.message}`;
      const remediation = `${issue.hint ?? issue.message} Then run \`kb marketplace plugins doctor --scope ${candidate.scope}\`.`;
      diag.error(issue.code, message, {
        pluginId: manifest.id,
        entityId: resolvedPackageName,
        filePath: policyResult.configPath,
        remediation,
      });
      return fail('manifest', message, policyResult.configPath, issue.code, remediation);
    }

    // Governance gate (plugins.allow / plugins.block / plugins.linked) for installed third-party packages
    if (candidate.origin === 'node_modules' && !this.passesPolicy(candidate, loaded.loaded.packageName, manifest.id, diag)) {
      return { events: diag.getEvents() };
    }

    const invalidCliCommandPaths = new Set<string>();
    for (const command of manifest.cli?.commands ?? []) {
      const validation = CliCommandDeclSchema.safeParse(command);
      if (!validation.success) {
        invalidCliCommandPaths.add(command.path);
        const remediation = `Correct the CLI command schema in ${loaded.loaded.packageName ?? manifest.id}, rebuild it, then run "kb marketplace plugins doctor --scope ${candidate.scope}".`;
        diag.error('COMMAND_SCHEMA_INVALID',
          `CLI command "${command.path}" in plugin "${manifest.id}" is invalid: ${validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}.`, {
            pluginId: manifest.id,
            entityKind: 'cli-command',
            entityId: command.path,
            filePath: loaded.loaded.manifestPath,
            remediation,
          });
      }
    }

    for (const command of manifest.cli?.commands ?? []) {
      if (invalidCliCommandPaths.has(command.path)) { continue; }
      const absoluteHandlerPath = resolveCliHandlerPath(packageRoot, command.handler);
      try {
        await fs.access(absoluteHandlerPath);
      } catch (error) {
        const failure = describeHandlerAccessFailure(error);
        const packageName = loaded.loaded.packageName ?? manifest.id;
        const buildCommand = `pnpm --filter ${packageName}... build`;
        const remediation = failure.code === 'COMMAND_HANDLER_MISSING'
          ? `Run \`${buildCommand}\`, then run \`kb marketplace plugins doctor --scope ${candidate.scope}\`.`
          : `Check access to the declared handler file, then run \`${buildCommand}\` and \`kb marketplace plugins doctor --scope ${candidate.scope}\`.`;
        diag.error(failure.code,
          `Command handler "${command.handler}" declared by plugin "${manifest.id}" ${failure.reason}.`, {
            pluginId: manifest.id,
            entityKind: 'cli-command',
            entityId: command.path,
            filePath: absoluteHandlerPath,
            remediation,
          });
      }
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
      packageName: loaded.loaded.packageName ?? candidate.packageName ?? manifest.id,
      scope: candidate.scope,
      origin: candidate.origin,
      manifestPath: loaded.loaded.manifestPath,
      manifestKind: loaded.loaded.kind,
      source: entry
        ? { kind: entry.source === 'platform' ? 'marketplace' : entry.source, path: entry.link ?? entry.resolvedPath ?? packageRoot }
        : { kind: 'local', path: relativeTo(candidate.root, packageRoot) },
      display: manifest.display
        ? { name: manifest.display.name, description: manifest.display.description }
        : undefined,
      integrity: entry?.integrity,
      signature: entry?.signature,
      provides: extractEntityKinds(manifest),
    };
    return { events: diag.getEvents(), loaded: { plugin, manifest, inputs: loaded.loaded.inputs } };
  }

  /** Apply plugins.allow/block/linked; records a diagnostic and returns false when the package is gated out. */
  private passesPolicy(
    candidate: Candidate,
    loadedName: string | undefined,
    manifestId: string,
    diag: DiagnosticCollector,
  ): boolean {
    const packageName = loadedName ?? candidate.packageName ?? manifestId;
    const policyResult = this.policies.get(candidate.root);
    const policy = policyResult?.kind === 'valid' ? policyResult.policy : {};
    const verdict = checkPluginPolicy(policy, [candidate.id, manifestId, packageName], {
      origin: candidate.origin, scope: candidate.scope, lockSource: candidate.entry?.source,
    });
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

  private recordInputRead(filePath: string, bytes?: Buffer): void {
    this.onInputRead?.(filePath, bytes);
    if (bytes) this.consumedInputDigests.set(path.resolve(filePath), createHash('sha256').update(bytes).digest('hex'));
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
