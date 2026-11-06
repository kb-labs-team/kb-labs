/**
 * @module @kb-labs/marketplace-npm/npm-source
 * pnpm-based PackageSource implementation.
 * This is the ONLY place in the marketplace codebase that calls pnpm.
 */

import { execa } from 'execa';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type {
  MarketplaceSource,
  ResolvedPackage,
  InstalledPackage,
} from '@kb-labs/marketplace-contracts';

export class PackageMetadataError extends Error {
  readonly code: 'PACKAGE_NOT_FOUND' | 'VERSION_NOT_FOUND' | 'UNKNOWN_ENTITY_KIND' | 'METADATA_FETCH_FAILED' | 'AUTH_FAILED' | 'TRANSPORT_FAILED';
  readonly packageId: string;
  readonly version: string;
  readonly hint: string;

  constructor(code: PackageMetadataError['code'], packageId: string, version: string, message: string) {
    super(message);
    this.name = 'PackageMetadataError';
    this.code = code;
    this.packageId = packageId;
    this.version = version;
    this.hint = `Publish ${packageId}@${version} with a kb.manifest or kb.adapter field, then run "kb marketplace install ${packageId}@${version}".`;
  }
}

export class PlatformArtifactPinsError extends Error {
  readonly code = 'KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING';
  readonly hint: string;

  constructor(root: string, packageId: string, version: string) {
    super("The installed platform is missing kb-create's sealed artifact overrides. No package was installed.");
    this.name = 'PlatformArtifactPinsError';
    this.hint = `Run "kb-create update --platform-root ${JSON.stringify(root)}" and retry "kb marketplace install ${packageId}@${version} --scope platform".`;
  }
}

export interface NpmPackageSourceOptions {
  registryUrl: string;
}

export class PackageInstallError extends Error {
  readonly code: 'NOT_FOUND' | 'INSTALL_FAILED' | 'RELEASE_TOO_FRESH' | 'INTEGRITY_MISMATCH';
  readonly spec: string;
  constructor(code: PackageInstallError['code'], spec: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PackageInstallError';
    this.code = code;
    this.spec = spec;
  }
}

export class NpmPackageSource implements MarketplaceSource {
  readonly kind = 'npm' as const;
  private readonly registryUrl: string;
  private readonly pendingInstalls = new Map<string, PackageManagerFileSnapshot[]>();

  constructor(options: NpmPackageSourceOptions) {
    this.registryUrl = options.registryUrl.replace(/\/$/, '');
  }

  async resolveIdentity(identity: string) {
    try {
      const resolved = await this.resolve(identity);
      return { status: 'found' as const, package: resolved };
    } catch (error) {
      if (error instanceof PackageMetadataError && error.code === 'PACKAGE_NOT_FOUND') {
        return { status: 'not-found-unowned' as const };
      }
      throw error;
    }
  }

  async resolve(spec: string): Promise<ResolvedPackage> {
    const id = extractPackageName(spec);
    if (!id) {
      throw new Error(`Invalid package spec: ${spec}`);
    }

    const requestedVersion = extractVersion(spec);
    const packageURL = `${this.registryUrl}/${encodeURIComponent(id).replace('%40', '@')}`;
    let response: Response;
    try {
      response = await globalThis.fetch(packageURL);
    } catch (error) {
      throw new PackageMetadataError('TRANSPORT_FAILED', id, requestedVersion ?? 'latest',
        `Could not read package metadata for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) {
      throw new PackageMetadataError('PACKAGE_NOT_FOUND', id, requestedVersion ?? 'latest', `Package ${id} was not found in ${this.registryUrl}`);
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'AUTH_FAILED'
        : response.status >= 500 ? 'TRANSPORT_FAILED' : 'METADATA_FETCH_FAILED';
      throw new PackageMetadataError(code, id, requestedVersion ?? 'latest', `Registry returned HTTP ${response.status} while reading ${id}`);
    }
    const packument = await response.json() as {
      'dist-tags'?: { latest?: string };
      versions?: Record<string, {
        kb?: { manifest?: string; adapter?: unknown };
        dist?: { integrity?: string; tarball?: string };
      }>;
    };
    const version = requestedVersion ?? packument['dist-tags']?.latest;
    const metadata = version ? packument.versions?.[version] : undefined;
    const manifest = metadata?.kb;
    if (!version || !manifest) {
      throw new PackageMetadataError('VERSION_NOT_FOUND', id, requestedVersion ?? 'latest',
        `Package ${id} has no published metadata for ${requestedVersion ?? 'latest'}`);
    }
    const primaryKind = manifest.adapter ? 'adapter' : manifest.manifest ? 'plugin' : undefined;
    if (!primaryKind) {
      throw new PackageMetadataError('UNKNOWN_ENTITY_KIND', id, version,
        `Package ${id}@${version} does not declare kb.manifest or kb.adapter metadata`);
    }

    return {
      id,
      version,
      integrity: isSRIIntegrity(metadata?.dist?.integrity)
        ? metadata.dist.integrity
        : '',
      source: 'marketplace',
      primaryKind,
      ...(metadata?.dist?.tarball ? { downloadUrl: metadata.dist.tarball } : {}),
    };
  }

  async install(
    pkg: ResolvedPackage,
    root: string,
    opts?: { dev?: boolean },
  ): Promise<InstalledPackage> {
    await assertSealedPlatformOverrides(root, pkg.id, pkg.version);
    if (pkg.integrity) { await verifyCatalogTarball(pkg); }
    const spec = pkg.version === 'latest' ? pkg.id : `${pkg.id}@${pkg.version}`;
    const args = ['add', spec, `--registry=${this.registryUrl}`];
    if (opts?.dev) {args.push('--save-dev');}
    // Bypass the pnpm workspace-root guard: kb-create projects are flat (single-package),
    // so adding to the project root is intentional. Without this flag pnpm throws
    // ERR_PNPM_ADDING_TO_ROOT when a pnpm-workspace.yaml exists in the project directory.
    args.push('--ignore-workspace-root-check');

    const state = await snapshotPackageManagerState(root);
    let pnpmStarted = false;
    try {
      if (pkg.integrity) { await mergeMinimumReleaseAgeExclude(root, pkg.id, pkg.version); }
      pnpmStarted = true;
      try {
        await execa('pnpm', args, { cwd: root, timeout: 5 * 60 * 1000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg.includes('ERR_PNPM_FETCH_404') || msg.includes('Not Found - 404')
          ? 'NOT_FOUND'
          : msg.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION') || msg.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
            ? 'RELEASE_TOO_FRESH'
            : msg.includes('ERR_PNPM_TARBALL_INTEGRITY') || msg.includes('ERR_PNPM_TARBALL_INTEGRITY_FAILED')
              ? 'INTEGRITY_MISMATCH'
              : 'INSTALL_FAILED';
        throw new PackageInstallError(code, spec, `pnpm add ${spec} failed: ${msg}`, { cause: err });
      }

      const packageRoot = path.join(root, 'node_modules', pkg.id);
      const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf-8')) as { version?: unknown };
      const version = typeof packageJson.version === 'string' ? packageJson.version : pkg.version;
      const lockIntegrity = pkg.integrity
        ? await readInstalledTarballIntegrity(root, pkg.id, pkg.version)
        : undefined;
      if (pkg.integrity && lockIntegrity !== pkg.integrity) {
        throw new PackageInstallError('INTEGRITY_MISMATCH', spec,
          `Installed tarball integrity did not match the Marketplace catalog pin for ${spec}.`);
      }
      const integrity = lockIntegrity ?? await computeIntegrity(packageRoot);

      this.pendingInstalls.set(installKey(root, pkg.id), state);
      return {
        id: pkg.id,
        version,
        packageRoot,
        integrity,
      };
    } catch (error) {
      try {
        if (pnpmStarted) {await reconcileRestoredPackageGraph(root, state);}
        else {await restorePackageManagerState(root, state);}
      } catch (rollbackError) {
        throw new PackageInstallError(
          'INSTALL_FAILED',
          spec,
          `Marketplace could not restore package-manager state after installing ${spec}. Run "pnpm install --offline" in ${root}, then retry "kb marketplace install ${spec}".`,
          { cause: new AggregateError([error, rollbackError], 'Marketplace package-manager rollback failed') },
        );
      }
      throw error;
    }
  }

  async commitInstall(packageId: string, root: string): Promise<void> {
    this.pendingInstalls.delete(installKey(root, packageId));
  }

  async rollbackInstall(packageId: string, root: string): Promise<void> {
    const key = installKey(root, packageId);
    const snapshot = this.pendingInstalls.get(key);
    if (!snapshot) {return;}
    await reconcileRestoredPackageGraph(root, snapshot);
    this.pendingInstalls.delete(key);
  }

  async remove(packageId: string, root: string): Promise<void> {
    await execa('pnpm', ['remove', packageId], { cwd: root, timeout: 2 * 60 * 1000 });
  }
}

function installKey(root: string, packageId: string): string {
  return `${path.resolve(root)}\0${packageId}`;
}

/** Check that kb-create owns and has written every sealed archive override. */
export async function assertSealedPlatformOverrides(root: string, packageId: string, version: string): Promise<void> {
  const receiptPath = path.join(root, '.kb', 'v2', 'receipt.json');
  const workspacePath = path.join(root, 'pnpm-workspace.yaml');
  try {
    await fs.access(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
    throw error;
  }
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as { plan?: { artifacts?: Array<{ package?: unknown; sha256?: unknown; tarball?: unknown; kind?: unknown }> } };
  const sealed = new Map<string, string>();
  for (const artifact of receipt.plan?.artifacts ?? []) {
    if (artifact.kind === 'binary' || typeof artifact.tarball !== 'string' || !artifact.tarball) { continue; }
    if (typeof artifact.package !== 'string' || typeof artifact.sha256 !== 'string' || !artifact.sha256) {
      throw new Error('Installed platform receipt contains an invalid sealed artifact identity. Run "kb-create doctor --platform-root <platform-root>".');
    }
    sealed.set(artifact.package, artifact.sha256);
  }
  if (sealed.size === 0) { throw new PlatformArtifactPinsError(root, packageId, version); }
  let workspace;
  try {
    workspace = await fs.readFile(workspacePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PlatformArtifactPinsError(root, packageId, version);
    }
    throw error;
  }
  const document = parseDocument(workspace);
  if (document.errors.length > 0) {
    throw new PlatformArtifactPinsError(root, packageId, version);
  }
  if (!isMap(document.contents)) {
    throw new PlatformArtifactPinsError(root, packageId, version);
  }
  const overrides = document.get('overrides', true);
  if (!isMap(overrides)) {
    throw new PlatformArtifactPinsError(root, packageId, version);
  }
  let cacheRoot: string;
  try {
    cacheRoot = await fs.realpath(path.join(root, '.kb', 'v2', 'cache'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PlatformArtifactPinsError(root, packageId, version);
    }
    throw error;
  }
  for (const [name, sha256] of sealed) {
    const override = overrides.get(name, true);
    const archive = path.join(cacheRoot, 'packages', `${sha256}.tgz`).split(path.sep).join('/');
    const spec = `file:${archive}`;
    if (!isScalar(override) || override.value !== spec) {
      throw new PlatformArtifactPinsError(root, packageId, version);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPackageName(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) {return null;}

  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');
    if (slashIndex === -1) {return null;}
    const versionSep = spec.lastIndexOf('@');
    return versionSep > slashIndex ? spec.slice(0, versionSep) : spec;
  }

  const versionSep = spec.indexOf('@');
  return versionSep > 0 ? spec.slice(0, versionSep) : spec;
}

function extractVersion(spec: string): string | null {
  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');
    const lastAt = spec.lastIndexOf('@');
    return lastAt > slashIndex ? spec.slice(lastAt + 1) : null;
  }
  const atIndex = spec.indexOf('@');
  return atIndex > 0 ? spec.slice(atIndex + 1) : null;
}

async function computeIntegrity(packageRoot: string): Promise<string> {
  const content = await fs.readFile(path.join(packageRoot, 'package.json'));
  const hash = crypto.createHash('sha256').update(content).digest('base64');
  return `sha256-${hash}`;
}

interface PackageManagerFileSnapshot {
  name: string;
  contents?: Buffer;
  mode?: number;
}

const PACKAGE_MANAGER_STATE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

async function snapshotPackageManagerState(root: string): Promise<PackageManagerFileSnapshot[]> {
  return Promise.all(PACKAGE_MANAGER_STATE_FILES.map(async name => {
    const file = path.join(root, name);
    try {
      const [contents, info] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      return { name, contents, mode: info.mode & 0o777 };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return { name }; }
      throw error;
    }
  }));
}

async function restorePackageManagerState(root: string, snapshot: PackageManagerFileSnapshot[]): Promise<void> {
  for (const entry of snapshot) {
    const file = path.join(root, entry.name);
    if (entry.contents === undefined) {
      await fs.rm(file, { force: true });
      continue;
    }
    await fs.writeFile(file, entry.contents, { mode: entry.mode });
    if (entry.mode !== undefined) { await fs.chmod(file, entry.mode); }
  }
}

async function reconcileRestoredPackageGraph(root: string, snapshot: PackageManagerFileSnapshot[]): Promise<void> {
  const workspace = snapshot.find(entry => entry.name === 'pnpm-workspace.yaml');
  await restorePackageManagerState(root, snapshot.filter(entry => entry.name !== 'pnpm-workspace.yaml'));
  try {
    // Keep the install's exact-version age exclusion active until pnpm removes
    // the candidate from its virtual store, then restore the prior policy file.
    await reconcilePackageManagerState(root, snapshot);
  } finally {
    if (workspace) {await restorePackageManagerState(root, [workspace]);}
  }
}

async function reconcilePackageManagerState(root: string, snapshot: PackageManagerFileSnapshot[]): Promise<void> {
  const hasLock = snapshot.some(entry => entry.name === 'pnpm-lock.yaml' && entry.contents !== undefined);
  const args = ['install', '--offline', hasLock ? '--frozen-lockfile' : '--lockfile=false'];
  await execa('pnpm', args, { cwd: root, timeout: 5 * 60 * 1000 });
}

export async function mergeMinimumReleaseAgeExclude(root: string, packageId: string, version: string): Promise<void> {
  const workspacePath = path.join(root, 'pnpm-workspace.yaml');
  let source: string;
  try {
    source = await fs.readFile(workspacePath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') { throw error; }
    source = '{}\n';
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Could not parse ${workspacePath}: ${document.errors[0]?.message ?? 'invalid YAML'}`);
  }
  if (!isMap(document.contents)) {
    throw new Error(`${workspacePath} must contain a YAML mapping`);
  }

  const existing = document.get('minimumReleaseAgeExclude', true);
  if (existing !== undefined && !isSeq(existing)) {
    throw new Error(`${workspacePath} minimumReleaseAgeExclude must be a list`);
  }
  const selectors: string[] = [];
  for (const item of existing?.items ?? []) {
    if (!isScalar(item) || typeof item.value !== 'string') {
      throw new Error(`${workspacePath} minimumReleaseAgeExclude entries must be strings`);
    }
    selectors.push(item.value);
  }

  const packagePrefix = `${packageId}@`;
  const samePackage = selectors.filter(selector => selector.startsWith(packagePrefix));
  const versions = new Set<string>([version]);
  for (const selector of samePackage) {
    for (const alternative of selector.slice(packagePrefix.length).split('||')) {
      const value = alternative.trim();
      if (value) { versions.add(value); }
    }
  }
  const mergedSelector = `${packagePrefix}${[...versions].sort().join(' || ')}`;
  const output = selectors.filter(selector => !selector.startsWith(packagePrefix));
  output.push(mergedSelector);
  document.set('minimumReleaseAgeExclude', output);
  await fs.writeFile(workspacePath, document.toString(), { mode: 0o600 });
}

async function readInstalledTarballIntegrity(root: string, packageId: string, version: string): Promise<string | undefined> {
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  const source = await fs.readFile(lockPath, 'utf8');
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Could not parse ${lockPath}: ${document.errors[0]?.message ?? 'invalid YAML'}`);
  }
  const lock = document.toJS() as { packages?: Record<string, { resolution?: { integrity?: unknown } }> };
  const packagePrefix = `${packageId}@${version}`;
  const entry = Object.entries(lock.packages ?? {}).find(([key]) => key === packagePrefix || key.startsWith(`${packagePrefix}(`))?.[1];
  const integrity = entry?.resolution?.integrity;
  return typeof integrity === 'string' ? integrity : undefined;
}

function isSRIIntegrity(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') { return false; }
  return value.split(/\s+/).every(token => {
    const separator = token.indexOf('-');
    if (separator <= 0) { return false; }
    const algorithm = token.slice(0, separator);
    const digest = token.slice(separator + 1);
    if (!['sha1', 'sha256', 'sha384', 'sha512'].includes(algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) {
      return false;
    }
    return Buffer.from(digest, 'base64').length === crypto.createHash(algorithm).digest().length;
  });
}

async function verifyCatalogTarball(pkg: ResolvedPackage): Promise<void> {
  if (!pkg.downloadUrl) {
    throw new PackageInstallError('INTEGRITY_MISMATCH', `${pkg.id}@${pkg.version}`,
      `Marketplace catalog provided an integrity pin without a tarball URL for ${pkg.id}@${pkg.version}.`);
  }
  const response = await globalThis.fetch(pkg.downloadUrl);
  if (!response.ok) {
    throw new PackageInstallError('INSTALL_FAILED', `${pkg.id}@${pkg.version}`,
      `Could not verify the catalog tarball for ${pkg.id}@${pkg.version}: HTTP ${response.status}.`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  const expected: Array<[string, string]> = pkg.integrity.split(/\s+/).map(token => {
    const separator = token.indexOf('-');
    return [token.slice(0, separator), token.slice(separator + 1)];
  });
  const strengths: Record<string, number> = { sha1: 1, sha256: 2, sha384: 3, sha512: 4 };
  const strongest = Math.max(...expected.map(([algorithm]) => strengths[algorithm] ?? 0));
  const matches = expected
    .filter(([algorithm]) => strengths[algorithm] === strongest)
    .some(([algorithm, digest]) => crypto.createHash(algorithm).update(content).digest('base64') === digest);
  if (!matches) {
    throw new PackageInstallError('INTEGRITY_MISMATCH', `${pkg.id}@${pkg.version}`,
      `Registry tarball integrity does not match the Marketplace catalog pin for ${pkg.id}@${pkg.version}.`);
  }
}
