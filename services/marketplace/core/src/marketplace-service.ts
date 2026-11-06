/**
 * @module @kb-labs/marketplace-core/marketplace-service
 * Unified marketplace service — install/uninstall/enable/disable for all entity types.
 *
 * Every mutating method is explicitly scope-bound (`platform` or `project`).
 * There is no implicit default: callers pass a `ScopeContext` per call so
 * the service can target the right `.kb/marketplace.lock`.
 *
 * Works through PackageSource abstraction — never calls pnpm directly.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { IntegrityMismatchError, type IExtensionStore } from '@kb-labs/core-extension-store';
import type { ILogger } from '@kb-labs/core-platform';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform/error-envelope';
import { resolveMarketplaceLockScope } from '@kb-labs/core-discovery';
import { glob } from 'glob';
import semver from 'semver';
import type { MarketplaceLock, MarketplaceLockEntry, EntityKind } from '@kb-labs/plugin-contracts';
import {
  readMarketplaceLock,
  writeMarketplaceLock,
  createEmptyLock,
  createMarketplaceEntry,
  createInstallOwnedRelativePath,
  addToMarketplaceLock,
  removeFromMarketplaceLock,
  enablePlugin,
  disablePlugin,
  DiagnosticCollector,
  loadManifestFile,
  extractEntityKinds,
  DiscoveryManager,
} from '@kb-labs/core-discovery';
import { isManifestV3, type ManifestV3 } from '@kb-labs/plugin-contracts';

import type {
  MarketplaceSource,
  PackageSource,
  EntityKindStrategy,
  MarketplaceServiceAPI,
  MarketplaceEntryWithId,
  ScopedMarketplaceEntry,
  ScopeContext,
  QueryScopeContext,
  MarketplaceScope,
  MarketplaceDiagnostic,
  InstallResult,
  InstallResultEntry,
  InstalledPackage,
  SyncResult,
  DoctorReport,
  DoctorIssue,
} from '@kb-labs/marketplace-contracts';
import { setCacheEntry, removeCacheEntry } from './manifest-cache.js';
import { PluginStrategy } from './strategies/plugin-strategy.js';
import { AdapterStrategy } from './strategies/adapter-strategy.js';
import { resolveScopeRoot, resolveQueryRoots, type ServiceRoots } from './scope.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MarketplaceServiceOptions {
  /** Platform workspace root — always required. Used for `scope: 'platform'`. */
  platformRoot: string;
  /**
   * Default project root. Optional — a daemon serving multiple projects can
   * leave this unset and pass `ctx.projectRoot` per call. When both are
   * provided, per-call `ctx.projectRoot` wins.
   */
  projectRoot?: string;
  /** Ordered identity sources from platform config; Registry precedes npm when configured. */
  sources: MarketplaceSource[];
  /** Shared machine store. When set, packages never enter project node_modules. */
  extensionStore?: IExtensionStore;
  /** Platform logger used by lifecycle strategies. */
  logger: ILogger;
  /** Additional strategies beyond built-in plugin/adapter */
  strategies?: EntityKindStrategy[];
}

export class MarketplaceVersionError extends Error {
  readonly code: 'INTEGRITY_MISMATCH' | 'VERSION_NOT_HIGHER' | 'INVALID_VERSION';

  constructor(
    code: MarketplaceVersionError['code'],
    readonly packageId: string,
    readonly installedVersion: string,
    readonly requestedVersion: string,
  ) {
    super(code === 'INTEGRITY_MISMATCH'
      ? `Installed ${packageId}@${installedVersion} has an immutable integrity pin that differs from the registry.`
      : code === 'VERSION_NOT_HIGHER'
        ? `Marketplace update for ${packageId} resolved ${requestedVersion}, which is not higher than installed version ${installedVersion}.`
        : `Marketplace resolved invalid version ${requestedVersion} for ${packageId}; installed version is ${installedVersion}.`);
    this.name = 'MarketplaceVersionError';
    this.code = code;
  }
}

function verifyResolvedArtifact(
  resolved: Awaited<ReturnType<PackageSource['resolve']>>,
  source: MarketplaceSource,
  scope: MarketplaceScope,
): { signatureStatus: 'verified' | 'unsigned' } {
  if (source.kind !== 'registry') { return { signatureStatus: 'unsigned' }; }
  if (!resolved.integrity) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_MARKETPLACE_INTEGRITY_MISMATCH', {
      details: { package: resolved.id, scope },
    }));
  }
  const signature = resolved.signature;
  const verificationKey = source.verificationKey;
  if (!signature || signature.algorithm !== 'ed25519' || !resolved.signatureSubject || !verificationKey) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_MARKETPLACE_SIGNATURE_INVALID', {
      details: { package: resolved.id, scope },
    }));
  }
  const payload = Buffer.from(JSON.stringify({ integrity: resolved.integrity, pkg: `${resolved.signatureSubject}@${resolved.version}` }));
  let valid = false;
  try {
    valid = crypto.verify(null, payload, { key: verificationKey, format: 'pem' }, Buffer.from(signature.value, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_MARKETPLACE_SIGNATURE_INVALID', {
      details: { package: resolved.id, scope },
    }));
  }
  return { signatureStatus: 'verified' };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MarketplaceService implements MarketplaceServiceAPI {
  private readonly roots: ServiceRoots;
  private readonly sources: MarketplaceSource[];
  private readonly extensionStore?: IExtensionStore;
  private readonly logger: ILogger;
  private readonly strategies = new Map<EntityKind, EntityKindStrategy>();
  /**
   * Package-manager and marketplace-lock mutations share a scope root. They
   * must never overlap: pnpm can mutate node_modules while another request
   * reads/writes the same lock, which previously made concurrent HTTP callers
   * observe partial state. The daemon owns one service instance, so a
   * per-scope promise queue is the correct transaction boundary here.
   */
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(opts: MarketplaceServiceOptions) {
    this.roots = { platformRoot: opts.platformRoot, projectRoot: opts.projectRoot };
    this.sources = opts.sources;
    this.extensionStore = opts.extensionStore;
    this.logger = opts.logger;

    // Built-in strategies
    this.registerStrategy(new PluginStrategy());
    this.registerStrategy(new AdapterStrategy(this.logger, opts.platformRoot));

    // User-supplied strategies
    if (opts.strategies) {
      for (const s of opts.strategies) {
        this.registerStrategy(s);
      }
    }
  }

  registerStrategy(strategy: EntityKindStrategy): void {
    this.strategies.set(strategy.kind, strategy);
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  async install(
    ctx: ScopeContext,
    specs: string[],
    opts?: { dev?: boolean; shareToken?: string },
  ): Promise<InstallResult> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    return this.withScopeMutation(scopeRoot, () => this.installInScope(ctx, scopeRoot, specs, opts, false));
  }

  private async installInScope(
    ctx: ScopeContext,
    scopeRoot: string,
    specs: string[],
    opts?: { dev?: boolean; shareToken?: string },
    isUpdate = false,
  ): Promise<InstallResult> {
    const installed: InstallResultEntry[] = [];
    const warnings: string[] = [];
    const diagnostics: MarketplaceDiagnostic[] = [];
    const lock = await readMarketplaceLock(scopeRoot, new DiagnosticCollector(), ctx.scope);

    for (const spec of specs) {
      let source: MarketplaceSource | undefined;
      let resolved: Awaited<ReturnType<MarketplaceSource['resolve']>> | undefined;
      const sourceResults: string[] = [];
      for (const configuredSource of this.sources) {
        const candidateSource = opts?.shareToken && configuredSource.withShareToken
          ? configuredSource.withShareToken(opts.shareToken)
          : configuredSource;
        const result = await candidateSource.resolveIdentity(spec);
        if (result.status === 'not-found-owned') {
          throw new ErrorEnvelopeError(createErrorEnvelope('KB_MARKETPLACE_IDENTITY_RESERVED', { details: { package: spec, scope: ctx.scope } }));
        }
        if (result.status === 'not-found-unowned') {
          sourceResults.push(`${candidateSource.kind}: ${result.status}`);
          continue;
        }
        sourceResults.push(`${candidateSource.kind}: found`);
        source = candidateSource;
        resolved = { ...result.package, source: 'marketplace' };
        break;
      }
      if (!source || !resolved) {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_NOT_FOUND', {
          details: { plugin: spec },
          cause: sourceResults.join('; '),
        }));
      }
      if (!resolved.primaryKind) {
        throw new PackageClassificationError(
          resolved.id,
          resolved.version,
        );
      }
      const verification = verifyResolvedArtifact(resolved, source, ctx.scope);
      const installedPin = findInstalledPin(lock, resolved.id);
      if (installedPin) {
        const installedVersion = installedPin.version;
        if (!semver.valid(installedVersion) || !semver.valid(resolved.version)) {
          throw new MarketplaceVersionError('INVALID_VERSION', resolved.id, installedVersion, resolved.version);
        }
        const order = semver.compare(resolved.version, installedVersion);
        if (order === 0 && resolved.integrity !== installedPin.integrity) {
          throw new MarketplaceVersionError('INTEGRITY_MISMATCH', resolved.id, installedVersion, resolved.version);
        }
        if (order < 0 || (isUpdate && order === 0)) {
          throw new MarketplaceVersionError('VERSION_NOT_HIGHER', resolved.id, installedVersion, resolved.version);
        }
      }
      // Project plugin pins use the shared version store (ADR-0048). Marketplace
      // plugin entry packages also use it at platform scope: adding them to the
      // installed platform root would make pnpm re-resolve the sealed graph.
      // Platform adapters remain in the platform graph for runtime resolution.
      const usesExtensionStore = this.extensionStore !== undefined &&
        (ctx.scope === 'project' || resolved.primaryKind === 'plugin');
      const marketplaceState = usesExtensionStore ? [] : await snapshotMarketplaceState(scopeRoot);
      const result = usesExtensionStore
        ? await this.installInStore(resolved)
        : await source.install(resolved, scopeRoot, opts);

      let canonicalId: string | null | undefined;
      try {

      // Detect primary kind via strategies. A null result means the installed
      // package is not a KB Labs entity (no plugin/adapter/... manifest) —
      // fail loudly and roll back the npm install instead of recording a bogus
      // lock entry (B-021).
      const primaryKind = await this.detectKind(result.packageRoot);
      if (primaryKind === null) {
        throw new InvalidEntityError(
          `Package "${result.id}" (resolved from "${spec}") is not a valid KB Labs entity — ` +
          `no plugin/adapter/workflow manifest found. Nothing was installed.`,
        );
      }
      this.assertScopeAllowsKind(ctx.scope, primaryKind);

      const strategy = this.strategies.get(primaryKind);
      canonicalId = strategy?.resolveId
        ? await strategy.resolveId(result.packageRoot)
        : result.id;
      if (!canonicalId) {
        throw new InvalidEntityError(
          `Package "${result.id}" (resolved from "${spec}") does not declare a canonical entity ID. ` +
          'Declare the ID in its KB manifest and retry the install.',
        );
      }
      if (canonicalId !== resolved.id) {
        throw new InvalidEntityError(
          `Package requested as "${resolved.id}" declares manifest identity "${canonicalId}". ` +
          `Publish the package with matching npm name and manifest ID, then rerun "kb marketplace install ${spec}".`,
        );
      }
      const provides = strategy
        ? await strategy.extractProvides(result.packageRoot)
        : [primaryKind];

      const trust: 'trusted' | 'untrusted' = verification.signatureStatus === 'verified' ? 'trusted' : 'untrusted';

      // Write to marketplace.lock
      const entryOptions = {
        version: result.version,
        integrity: result.integrity,
        primaryKind,
        provides,
        trust,
        signature: resolved.signature,
        marketplaceSource: source.kind,
        signatureStatus: verification.signatureStatus,
      };
      const packagePath = relativeToRoot(scopeRoot, result.packageRoot);
      const entrySource = resolved.source;
      const entry = entrySource === 'marketplace'
        ? createMarketplaceEntry({ ...entryOptions, source: 'marketplace', package: result.id, resolvedPath: usesExtensionStore ? undefined : packagePath })
        : createMarketplaceEntry({ ...entryOptions, source: 'local', resolvedPath: packagePath });

      await addToMarketplaceLock(scopeRoot, canonicalId, entry, ctx.scope);

      // Cache manifest
      if (!this.extensionStore) {
        await this.cacheManifest(scopeRoot, canonicalId, result.packageRoot, primaryKind, result.integrity);
      }

      // Run post-install hook
      if (strategy?.afterInstall) {
        try {
          await strategy.afterInstall(canonicalId, result.packageRoot, this, ctx);
        } catch (err) {
          warnings.push(`afterInstall for ${canonicalId}: ${(err as Error).message}`);
        }
      }

      installed.push({
        spec,
        id: canonicalId,
        version: result.version,
        primaryKind,
        provides,
        packageRoot: result.packageRoot,
        scope: ctx.scope,
        source: source.kind,
        signatureStatus: verification.signatureStatus,
      });
      if (!usesExtensionStore) {await source.commitInstall(result.id, scopeRoot);}
      } catch (error) {
        if (!usesExtensionStore) {
          const rollbackErrors: unknown[] = [];
          try {
            await source.rollbackInstall(result.id, scopeRoot);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          try {
            await restoreMarketplaceState(marketplaceState);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (rollbackErrors.length > 0) {
            throw new MarketplaceInstallRollbackError(
              result.id, ctx.scope, source.kind, scopeRoot, error,
              new AggregateError(rollbackErrors, 'Marketplace install rollback failed'),
            );
          }
        }
        throw error;
      }
    }

    return { installed, warnings, scope: ctx.scope, diagnostics: diagnostics.length ? diagnostics : undefined };
  }

  // -------------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------------

  async uninstall(ctx: ScopeContext, packageIds: string[]): Promise<void> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    await this.withScopeMutation(scopeRoot, () => this.uninstallInScope(ctx, scopeRoot, packageIds));
  }

  private async uninstallInScope(ctx: ScopeContext, scopeRoot: string, packageIds: string[]): Promise<void> {
    for (const id of packageIds) {
      // Look up the entry first — if not tracked we skip source removal (idempotent).
      const entry = await this.getEntry(ctx, id);

      if (!entry) {
        // Package not in lock — nothing to uninstall. Remove any stale cache entries
        // but do not call source.remove (pnpm would fail on an unknown package).
        await removeCacheEntry(scopeRoot, id);
        continue;
      }

      // Run pre-uninstall hook
      const packageRoot = await this.resolveEntryPath(scopeRoot, id, entry);
      const kind = packageRoot ? await this.detectKind(packageRoot) : null;
      const strategy = kind ? this.strategies.get(kind) : undefined;
      if (strategy?.beforeUninstall) {
        await strategy.beforeUninstall(id, this, ctx);
      }

      const packageName = entry.source === 'local' ? undefined : ('package' in entry ? entry.package : id);

      await removeFromMarketplaceLock(scopeRoot, id, ctx.scope);
      await removeCacheEntry(scopeRoot, id);
      if (!this.extensionStore && packageName) {
        const source = entry.source === 'marketplace' ? this.sources.find(item => item.kind === entry.marketplaceSource) : this.sources[0];
        if (source) { await source.remove(packageName, scopeRoot); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Link / Unlink
  // -------------------------------------------------------------------------

  async link(ctx: ScopeContext, packagePath: string, sourceManifest?: unknown): Promise<InstallResultEntry> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    return this.withScopeMutation(scopeRoot, () => this.linkInScope(ctx, scopeRoot, packagePath, sourceManifest));
  }

  private async linkInScope(
    ctx: ScopeContext,
    scopeRoot: string,
    packagePath: string,
    sourceManifest?: unknown,
  ): Promise<InstallResultEntry> {
    const absPath = path.resolve(scopeRoot, packagePath);

    // Path traversal guard — linked path must be within the scope root.
    if (!isPathInside(scopeRoot, absPath)) {
      throw new Error(
        `Path "${packagePath}" is outside ${ctx.scope} root "${scopeRoot}" — refusing to link`,
      );
    }

    const pkgJson = JSON.parse(
      await fs.readFile(path.join(absPath, 'package.json'), 'utf-8'),
    );
    const id: string = pkgJson.name;
    const version: string = pkgJson.version ?? '0.0.0';

    // Scaffold can link a package before its TypeScript entry has been built.
    // In that case the caller supplies the generated manifest; it is still
    // validated here and becomes the canonical source for lock/cache metadata.
    const manifest = sourceManifest && isManifestV3(sourceManifest)
      ? sourceManifest as ManifestV3
      : undefined;
    const primaryKind = manifest ? 'plugin' : await this.detectKind(absPath);
    if (primaryKind === null) {
      throw new InvalidEntityError(
        `Cannot link "${id}" (${absPath}) — not a valid KB Labs entity ` +
        `(no plugin/adapter/workflow manifest found).`,
      );
    }
    this.assertScopeAllowsKind(ctx.scope, primaryKind);

    const strategy = this.strategies.get(primaryKind);
    const provides = manifest
      ? extractEntityKinds(manifest)
      : strategy
        ? await strategy.extractProvides(absPath)
        : [primaryKind];

    const integrity = await computeIntegrity(absPath);

    const entry = createMarketplaceEntry({
      version,
      integrity,
      resolvedPath: relativeToRoot(scopeRoot, absPath),
      source: 'local',
      primaryKind,
      provides,
    });

    const resolvedId = manifest?.id ?? (strategy?.resolveId ? await strategy.resolveId(absPath) : null);
    const canonicalId = resolvedId ?? id;
    await addToMarketplaceLock(scopeRoot, canonicalId, entry, ctx.scope);
    await this.cacheManifest(scopeRoot, canonicalId, absPath, primaryKind, integrity, manifest);

    if (strategy?.afterInstall) {
      await strategy.afterInstall(canonicalId, absPath, this, ctx);
    }

    return { id: canonicalId, version, primaryKind, provides, packageRoot: absPath, scope: ctx.scope, source: 'local', signatureStatus: 'not-applicable' };
  }

  async unlink(ctx: ScopeContext, packageId: string): Promise<void> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    await this.withScopeMutation(scopeRoot, async () => {
      await removeFromMarketplaceLock(scopeRoot, packageId, ctx.scope);
      await removeCacheEntry(scopeRoot, packageId);
    });
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(ctx: ScopeContext, packageIds?: string[]): Promise<InstallResult> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    return this.withScopeMutation(scopeRoot, async () => {
      const lock = await readMarketplaceLock(scopeRoot, new DiagnosticCollector(), ctx.scope);
      if (!lock) {
        return { installed: [], warnings: ['No marketplace.lock found'], scope: ctx.scope };
      }

      const ids = packageIds ?? Object.keys(lock.plugins);
      const warnings = packageIds
        ?.filter(id => !(id in lock.plugins))
        .map(id => `Plugin ${id} is not installed in the ${ctx.scope} scope and cannot be updated.`) ?? [];
      const specs = ids.filter(id => id in lock.plugins).map(id => {
        const entry = lock.plugins[id]!;
        return entry.package!;
      });

      const result = await this.installInScope(ctx, scopeRoot, specs, undefined, true);
      return { ...result, warnings: [...warnings, ...result.warnings] };
    });
  }

  // -------------------------------------------------------------------------
  // Enable / Disable
  // -------------------------------------------------------------------------

  async enable(ctx: ScopeContext, packageId: string): Promise<void> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    await this.withScopeMutation(scopeRoot, async () => {
      const ok = await enablePlugin(scopeRoot, packageId, ctx.scope);
      if (!ok) {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_NOT_INSTALLED', {
          details: { package: packageId },
        }));
      }
    });
  }

  async disable(ctx: ScopeContext, packageId: string): Promise<void> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    await this.withScopeMutation(scopeRoot, async () => {
      const ok = await disablePlugin(scopeRoot, packageId, ctx.scope);
      if (!ok) {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_NOT_INSTALLED', {
          details: { package: packageId },
        }));
      }
    });
  }

  private async withScopeMutation<T>(scopeRoot: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(scopeRoot) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>(resolve => { release = resolve; });
    const queuedTail = previous.then(() => tail);
    this.mutationTails.set(scopeRoot, queuedTail);

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.mutationTails.get(scopeRoot) === queuedTail) {
        this.mutationTails.delete(scopeRoot);
      }
    }
  }

  private async installInStore(
    resolved: Awaited<ReturnType<PackageSource['resolve']>>,
  ): Promise<InstalledPackage> {
    const store = this.extensionStore;
    if (!store) {
      throw new Error('Extension store is not configured. Restart the platform with `kb-create start`.');
    }
    const entry = await store.resolve({
      name: resolved.id,
      version: resolved.version,
      kind: 'plugin',
      ...(resolved.downloadUrl ? { spec: resolved.downloadUrl } : {}),
      ...(resolved.integrity ? { expectedIntegrity: resolved.integrity } : {}),
    });
    return {
      id: entry.entry.name,
      version: entry.entry.version,
      packageRoot: entry.packageRoot,
      integrity: entry.entry.integrity,
    };
  }

  // -------------------------------------------------------------------------
  // List / GetEntry (MarketplaceServiceAPI)
  // -------------------------------------------------------------------------

  async list(
    ctx: QueryScopeContext,
    filter?: { kind?: EntityKind },
  ): Promise<ScopedMarketplaceEntry[]> {
    const targets = resolveQueryRoots(this.roots, ctx);

    // Collect per-scope entries. For 'all' we later apply project-wins.
    const perScope: Array<{ scope: MarketplaceScope; entries: MarketplaceEntryWithId[] }> = [];
    for (const { scope, root } of targets) {
      const diag = new DiagnosticCollector();
      const lock = await readMarketplaceLock(root, diag, scope);
      if (!lock) {
        perScope.push({ scope, entries: [] });
        continue;
      }
      const entries = [...Object.entries(lock.plugins), ...Object.entries(lock.adapters ?? {})].map(([id, entry]) => ({ ...entry, id }));
      perScope.push({ scope, entries });
    }

    const merged = mergeScopedEntries(perScope);
    if (!filter?.kind) {return merged.entries;}
    const matching: ScopedMarketplaceEntry[] = [];
    for (const entry of merged.entries) {
      const packageRoot = await this.resolveEntryPath(resolveScopeRoot(this.roots, { scope: entry.scope, projectRoot: ctx.projectRoot }), entry.id, entry);
      if (packageRoot && await this.detectKind(packageRoot) === filter.kind) {matching.push(entry);}
    }
    return matching;
  }

  async getEntry(ctx: ScopeContext, packageId: string): Promise<MarketplaceLockEntry | null> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    const diag = new DiagnosticCollector();
    const lock = await readMarketplaceLock(scopeRoot, diag, ctx.scope);
    return lock?.plugins[packageId] ?? lock?.adapters?.[packageId] ?? null;
  }

  // -------------------------------------------------------------------------
  // Sync (scan workspace → populate lock from config-driven globs)
  // -------------------------------------------------------------------------

  /**
   * Scan workspace for plugins and adapters using glob patterns.
   * Existing entries are preserved (not overwritten).
   * Patterns come from kb.config.json marketplace.sync.include.
   *
   * Sync is scope-bound: globs resolve against the scope root and results go
   * into that scope's lock. Adapter discovery in `project` scope is refused
   * with a clear error to preserve the adapters-are-platform-only invariant.
   */
  async sync(
    ctx: ScopeContext,
    opts: {
      include: string[];
      exclude?: string[];
      autoEnable?: boolean;
    },
  ): Promise<SyncResult> {
    let effectiveCtx = ctx;
    let scopeRoot: string;
    if (ctx.scope === 'project') {
      const projectRoot = ctx.projectRoot ?? this.roots.projectRoot;
      if (projectRoot && path.isAbsolute(projectRoot)) {
        const lockScope = await resolveMarketplaceLockScope(
          { ...this.roots, projectRoot },
          projectRoot,
        );
        if (lockScope === 'platform') {
          // In development mode one physical lock can own both logical roots.
          // Runtime adapter discovery treats that shared file as platform-owned.
          effectiveCtx = { ...ctx, scope: 'platform' };
        }
      }
    }
    scopeRoot = resolveScopeRoot(this.roots, effectiveCtx);
    return this.withScopeMutation(scopeRoot, () => this.syncInScope(effectiveCtx, scopeRoot, opts));
  }

  private async syncInScope(
    ctx: ScopeContext,
    scopeRoot: string,
    opts: {
      include: string[];
      exclude?: string[];
      autoEnable?: boolean;
    },
  ): Promise<SyncResult> {
    const autoEnable = opts.autoEnable ?? false;
    const diag = new DiagnosticCollector();
    const readScope = ctx.scope === 'project' ? 'platform' : ctx.scope;
    const lock = await readMarketplaceLock(scopeRoot, diag, readScope) ?? createEmptyLock();
    if (ctx.scope === 'project') {
      delete lock.adapters;
    }
    const existingIds = new Set([
      ...Object.keys(lock.plugins),
      ...Object.keys(lock.adapters ?? {}),
    ]);

    const added: SyncResult['added'] = [];
    const skipped: SyncResult['skipped'] = [];

    const includePatterns = opts.include.map(p => path.join(p, 'package.json'));
    const excludePatterns = opts.exclude ?? [];

    const packageJsonPaths = await glob(includePatterns, {
      cwd: scopeRoot,
      ignore: excludePatterns,
      absolute: false,
    });

    for (const relPkgJson of packageJsonPaths) {
      const pkgDir = path.resolve(scopeRoot, path.dirname(relPkgJson));
      await this._syncPackage(ctx.scope, scopeRoot, pkgDir, relPkgJson, existingIds, autoEnable, lock, added, skipped);
    }

    await writeMarketplaceLock(scopeRoot, lock, ctx.scope);

    return { added, skipped, total: Object.keys(lock.plugins).length + Object.keys(lock.adapters ?? {}).length };
  }

  private async _syncPackage(
    scope: MarketplaceScope,
    scopeRoot: string,
    pkgDir: string,
    _relPkgJson: string,
    existingIds: Set<string>,
    autoEnable: boolean,
    lock: MarketplaceLock,
    added: SyncResult['added'],
    skipped: SyncResult['skipped'],
  ): Promise<void> {
    let pkgName: string;
    let pkgVersion: string;
    try {
      const pkgJson = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8'));
      pkgName = pkgJson.name;
      pkgVersion = pkgJson.version ?? '0.0.0';
      if (!pkgName) { return; }
    } catch {
      return;
    }

    if (existingIds.has(pkgName)) {
      skipped.push({ id: pkgName, reason: 'already in lock' });
      return;
    }

    const primaryKind = await this.detectKind(pkgDir);
    // Not a KB Labs entity — skip silently during scan (unlike install/link,
    // scanning node_modules legitimately encounters many non-entity packages).
    if (primaryKind === null) { return; }

    // Adapters can only live in platform scope.
    if (scope === 'project' && primaryKind === 'adapter') {
      skipped.push({ id: pkgName, reason: 'adapter not allowed in project scope' });
      return;
    }

    const strategy = this.strategies.get(primaryKind);
    const provides = strategy ? await strategy.extractProvides(pkgDir) : [primaryKind];
    const integrity = await computeIntegrity(pkgDir);

    // Use manifest ID as lock key if the strategy can resolve it.
    // This keeps discovery working even when package.json name differs from manifest.id
    // (e.g. after folder renames like cli/ → entry/).
    const resolvedId = (strategy?.resolveId ? await strategy.resolveId(pkgDir) : null) ?? pkgName;

    if (existingIds.has(resolvedId) && resolvedId !== pkgName) {
      skipped.push({ id: resolvedId, reason: 'already in lock' });
      return;
    }

    const resolvedPath = relativeToRoot(scopeRoot, pkgDir);
    if (primaryKind === 'adapter') {
      const adapters = (lock.adapters ??= {});
      adapters[resolvedId] = {
        source: 'platform',
        version: pkgVersion,
        integrity,
        resolvedPath: createInstallOwnedRelativePath(resolvedPath, scopeRoot),
        enabled: autoEnable ?? true,
      };
    } else {
      const entry = createMarketplaceEntry({
        version: pkgVersion,
        integrity,
        resolvedPath,
        source: 'local',
        primaryKind,
        provides,
      });
      if (!autoEnable) { entry.enabled = false; }
      lock.plugins[resolvedId] = entry;
    }
    existingIds.add(resolvedId);
    added.push({ id: resolvedId, primaryKind, version: pkgVersion });
  }

  // -------------------------------------------------------------------------
  // Doctor
  // -------------------------------------------------------------------------

  async doctor(ctx: ScopeContext): Promise<DoctorReport> {
    const scopeRoot = resolveScopeRoot(this.roots, ctx);
    const diag = new DiagnosticCollector();
    const lock = await readMarketplaceLock(scopeRoot, diag, ctx.scope);
    const issues: DoctorIssue[] = [];

    if (!lock) {
      const provenanceError = diag.getEvents().find(event => event.code === 'MARKETPLACE_PROVENANCE_REQUIRED');
      if (provenanceError?.context?.pluginId) {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_MARKETPLACE_PROVENANCE_REQUIRED', {
          details: { package: provenanceError.context.pluginId, scope: ctx.scope },
        }));
      }
      return { ok: true, total: 0, issues: [{ severity: 'info', packageId: '', message: 'No marketplace.lock found' }], provenance: [] };
    }

    const entries = [...Object.entries(lock.plugins), ...Object.entries(lock.adapters ?? {})];
    const provenance = entries.flatMap(([packageId, entry]) => entry.source === 'marketplace' ? [{
      packageId, source: entry.marketplaceSource, integrity: entry.integrity, signatureStatus: entry.signatureStatus,
    }] : []);

    for (const [id, entry] of entries) {
      let pkgRoot: string | undefined;
      try {
        pkgRoot = await this.resolveEntryPath(scopeRoot, id, entry);
      } catch (error) {
        if (!(error instanceof IntegrityMismatchError)) { throw error; }
        // Discovery below reports this same typed mismatch with its catalogue hint.
        continue;
      }

      if (!pkgRoot) {
        issues.push({
          severity: 'error',
          packageId: id,
          diagnosticCode: 'PACKAGE_NOT_FOUND',
          message: `Pinned package ${id}@${entry.version ?? 'unknown version'} was not found at its configured location`,
          remediation: `Run "kb marketplace install ${id}" to restore`,
        });
        continue;
      }

      try {
        await fs.access(pkgRoot);
      } catch {
        issues.push({
          severity: 'error',
          packageId: id,
          diagnosticCode: 'PACKAGE_NOT_FOUND',
          message: `Package directory not found: ${pkgRoot}`,
          remediation: `Run "kb marketplace install ${id}" to restore`,
        });
        continue;
      }

      if (!('signature' in entry) || !entry.signature) {
        issues.push({
          severity: 'info',
          packageId: id,
          message: 'Package is not signed',
          remediation: 'Publish through the official marketplace to get a platform signature',
        });
      }
    }

    const discovery = await new DiscoveryManager({
      root: scopeRoot,
      scope: ctx.scope,
      workspace: false,
      extensionStore: this.extensionStore,
    }).discover();
    for (const failure of discovery.failures) {
      const event = discovery.diagnostics.find(item => item.context?.pluginId === failure.id && item.severity === 'error');
      issues.push({
        severity: 'error',
        packageId: failure.id,
        diagnosticCode: failure.diagnosticCode ?? event?.code ?? 'PLUGIN_DISCOVERY_FAILED',
        message: failure.message,
        path: event?.context?.filePath,
        remediation: failure.remediation ?? event?.remediation ?? `Run "kb marketplace plugins doctor --scope ${ctx.scope}" after correcting this plugin.`,
      });
    }
    const failedPluginIds = new Set(discovery.failures.map(failure => failure.id));
    for (const event of discovery.diagnostics) {
      const pluginId = event.context?.pluginId;
      if (event.severity !== 'error' || !pluginId || failedPluginIds.has(pluginId)) { continue; }
      issues.push({
        severity: 'error',
        packageId: pluginId,
        diagnosticCode: event.code,
        message: event.message,
        remediation: event.remediation ?? `Run "kb marketplace plugins doctor --scope ${ctx.scope}" after correcting this plugin.`,
      });
    }

    return {
      ok: issues.filter(i => i.severity === 'error').length === 0,
      total: entries.length,
      issues,
      provenance,
    };
  }

  private async resolveEntryPath(scopeRoot: string, id: string, entry: MarketplaceLockEntry): Promise<string | undefined> {
    if (entry.source === 'marketplace' && 'package' in entry && this.extensionStore && entry.version) {
      return (await this.extensionStore.lookup({ name: entry.package, version: entry.version, expectedIntegrity: entry.integrity }))?.packageRoot;
    }
    if ('link' in entry && entry.link) {return path.resolve(scopeRoot, entry.link);}
    if ('resolvedPath' in entry && entry.resolvedPath) {return path.resolve(scopeRoot, entry.resolvedPath);}
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Detect the primary entity kind of a package via registered strategies.
   * Returns null when no strategy recognizes the package — i.e. it is not a
   * valid KB Labs entity (no plugin/adapter/... manifest). Callers MUST treat
   * null as a hard failure rather than defaulting to 'plugin' (B-021): a plain
   * npm package with no kb manifest must never be recorded as a plugin.
   */
  private async detectKind(packageRoot: string): Promise<EntityKind | null> {
    for (const strategy of this.strategies.values()) {
      const kind = await strategy.detectKind(packageRoot);
      if (kind) { return kind; }
    }
    return null;
  }

  /**
   * Hard guard: adapters may only be installed/linked in platform scope.
   * Lives in one place so adapter-scope policy is not duplicated across
   * `link`, `install`, and `sync`.
   */
  private assertScopeAllowsKind(scope: MarketplaceScope, kind: EntityKind): void {
    if (scope === 'project' && kind === 'adapter') {
      throw new AdapterScopeError(
        'Adapters can only be installed in platform scope. ' +
        'Use --scope platform or install globally via the platform marketplace.',
      );
    }
  }

  private async cacheManifest(
    scopeRoot: string,
    packageId: string,
    packageRoot: string,
    primaryKind: EntityKind,
    integrity: string,
    sourceManifest?: ManifestV3,
  ): Promise<void> {
    try {
      if (primaryKind === 'plugin') {
        if (sourceManifest) {
          await setCacheEntry(scopeRoot, packageId, {
            manifestType: 'plugin',
            manifest: sourceManifest,
            cachedAt: new Date().toISOString(),
            integrity,
          });
          return;
        }
        const diag = new DiagnosticCollector();
        const result = await loadManifestFile(packageRoot, diag);
        if (result.kind === 'manifest') {
          await setCacheEntry(scopeRoot, packageId, {
            manifestType: 'plugin',
            manifest: result.loaded.manifest,
            cachedAt: new Date().toISOString(),
            integrity,
          });
        }
      } else if (primaryKind === 'adapter') {
        const distPath = path.join(packageRoot, 'dist', 'index.js');
        const mod = await import(pathToFileURL(distPath).href);
        if (mod.manifest) {
          await setCacheEntry(scopeRoot, packageId, {
            manifestType: 'adapter',
            manifest: mod.manifest,
            cachedAt: new Date().toISOString(),
            integrity,
          });
        }
      }
    } catch (err) {
      console.warn(`[marketplace] Failed to cache manifest for "${packageId}": ${(err as Error).message}`);
    }
  }
}

function findInstalledPin(
  lock: MarketplaceLock | null,
  packageId: string,
): { version: string; integrity: string } | undefined {
  if (!lock) { return undefined; }
  const plugin = Object.entries(lock.plugins).find(([id, entry]) =>
    id === packageId || (entry.source !== 'local' && entry.package === packageId),
  )?.[1];
  if (plugin && plugin.source !== 'local') {
    return { version: plugin.version, integrity: plugin.integrity };
  }
  const adapter = lock.adapters?.[packageId];
  return adapter ? { version: adapter.version, integrity: adapter.integrity } : undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdapterScopeError extends Error {
  readonly code = 'MARKETPLACE_ADAPTER_PROJECT_SCOPE';
  constructor(message: string) {
    super(message);
    this.name = 'AdapterScopeError';
  }
}

export class MarketplaceInstallRollbackError extends Error {
  readonly code = 'KB_MARKETPLACE_INSTALL_FAILED';
  readonly hint: string;

  constructor(readonly packageId: string, readonly scope: MarketplaceScope, readonly source: string, scopeRoot: string, cause: unknown, rollbackCause: unknown) {
    super(`Marketplace could not restore the platform after installing ${packageId}.`, {
      cause: new AggregateError([cause, rollbackCause], 'Marketplace install rollback failed'),
    });
    this.name = 'MarketplaceInstallRollbackError';
    this.hint = `Run "pnpm install --offline" in ${scopeRoot} to restore the package graph, then retry "kb marketplace install ${packageId} --scope ${scope}".`;
  }
}

/**
 * Thrown when a package was resolved/installed but is not a recognizable KB Labs
 * entity (no plugin/adapter/workflow manifest). Maps to HTTP 422. Prevents
 * recording bogus lock entries for unrelated npm packages (B-021).
 */
export class InvalidEntityError extends Error {
  readonly code = 'MARKETPLACE_NOT_AN_ENTITY';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntityError';
  }
}

/** Package metadata must classify an entity before marketplace install mutates a scope. */
export class PackageClassificationError extends Error {
  readonly code = 'MARKETPLACE_PACKAGE_KIND_UNKNOWN';
  readonly hint: string;
  constructor(packageId: string, version: string) {
    super(`Package "${packageId}@${version}" has no declared KB Labs entity kind. Registry metadata must declare kb.manifest (plugin) or kb.adapter (adapter). Nothing was installed.`);
    this.name = 'PackageClassificationError';
    this.hint = `Publish ${packageId}@${version} with kb.manifest or kb.adapter metadata, then run "kb marketplace install ${packageId}@${version}".`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MarketplaceStateFile {
  path: string;
  contents?: Buffer;
  mode?: number;
}

async function snapshotMarketplaceState(root: string): Promise<MarketplaceStateFile[]> {
  return Promise.all(['.kb/marketplace.lock', '.kb/marketplace.manifests.json'].map(async relativePath => {
    const filePath = path.join(root, relativePath);
    try {
      const [contents, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
      return { path: filePath, contents, mode: stat.mode & 0o777 };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { path: filePath };
      }
      throw error;
    }
  }));
}

async function restoreMarketplaceState(snapshot: MarketplaceStateFile[]): Promise<void> {
  for (const file of snapshot) {
    if (file.contents === undefined) {
      await fs.rm(file.path, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.contents, { mode: file.mode });
    if (file.mode !== undefined) {await fs.chmod(file.path, file.mode);}
  }
}

function relativeToRoot(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function computeIntegrity(packageRoot: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(packageRoot, 'package.json'));
    return `sha256-${crypto.createHash('sha256').update(content).digest('base64')}`;
  } catch {
    return '';
  }
}

/**
 * Merge per-scope entries with project-wins precedence.
 *
 * For a given package id present in both platform and project, the project
 * entry is kept and a diagnostic is emitted so the caller can surface the
 * override.
 */
export function mergeScopedEntries(
  perScope: Array<{ scope: MarketplaceScope; entries: MarketplaceEntryWithId[] }>,
): { entries: ScopedMarketplaceEntry[]; diagnostics: MarketplaceDiagnostic[] } {
  const out = new Map<string, ScopedMarketplaceEntry>();
  const diagnostics: MarketplaceDiagnostic[] = [];

  // Process project first so project entries land first and platform
  // duplicates are skipped with a diagnostic.
  const ordered = [...perScope].sort((a, b) => {
    if (a.scope === b.scope) { return 0; }
    return a.scope === 'project' ? -1 : 1;
  });

  for (const { scope, entries } of ordered) {
    for (const e of entries) {
      const existing = out.get(e.id);
      if (existing) {
        // project-wins: ignore subsequent duplicates, emit a diagnostic.
        diagnostics.push({
          code: 'MARKETPLACE_SCOPE_COLLISION',
          message: `Package "${e.id}" exists in both platform and project scopes — project wins.`,
          packageId: e.id,
          scope,
        });
        continue;
      }
      out.set(e.id, { ...e, scope });
    }
  }

  return { entries: Array.from(out.values()), diagnostics };
}
