/**
 * @module @kb-labs/marketplace-npm/registry-source
 * KB Labs Registry PackageSource implementation.
 * Resolves/installs packages from the KB Registry (kb:handle/name spec).
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { extract } from 'tar';
import type { MarketplaceSource, ResolvedPackage, InstalledPackage } from '@kb-labs/marketplace-contracts';
import { registryEndpointUrl } from './registry-url.js';

export class RegistryPackageError extends Error {
  readonly code: string;
  readonly identity: string;
  constructor(code: string, message: string, identity: string) {
    super(message);
    this.name = 'RegistryPackageError';
    this.code = code;
    this.identity = identity;
  }
}

export interface RegistrySourceOptions {
  /** Base URL of the registry (e.g. https://registry.kblabs.ru) */
  registryUrl: string;
  /** Bearer token for authenticated (private) package access */
  authToken?: string;
  /** Share token for token-based private access */
  shareToken?: string;
  /** Ed25519 public key (PEM) for signature verification */
  signingPublicKey: string;
}

export class RegistryPackageSource implements MarketplaceSource {
  readonly kind = 'registry' as const;
  readonly verificationKey: string;
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly shareToken?: string;
  private readonly pendingInstalls = new Map<string, {
    packageRoot: string;
    stagingRoot: string;
    backupPath?: string;
    activated: boolean;
  }>();

  constructor(opts: RegistrySourceOptions) {
    this.baseUrl = opts.registryUrl.replace(/\/$/, '');
    this.authToken = opts.authToken;
    this.shareToken = opts.shareToken;
    if (!opts.signingPublicKey) {
      throw new RegistryPackageError('KB_CONFIG_SECRET_MISSING', 'Registry signing public key is required by marketplace.sources.', 'unknown');
    }
    this.verificationKey = opts.signingPublicKey;
  }

  get registrySourceUrl(): string {
    return this.baseUrl;
  }

  async resolveIdentity(identity: string) {
    const { identity: canonicalIdentity, version } = splitIdentityVersion(identity);
    const query = new URLSearchParams({ identity: canonicalIdentity });
    if (version) { query.set('version', version); }
    const response = await this.fetch(`${registryEndpointUrl(this.baseUrl, 'resolve')}?${query.toString()}`, identity);
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? 'AUTH_FAILED'
        : response.status >= 500 ? 'TRANSPORT_FAILED' : 'RESOLUTION_FAILED';
      throw new RegistryPackageError(code, `Registry identity resolution failed with HTTP ${response.status}`, identity);
    }
    const result = await response.json() as import('@kb-labs/marketplace-contracts').MarketplaceSourceResolution;
    if (result.status !== 'found') { return result; }
    const downloadUrl = result.package.downloadUrl
      ? this.resolveDownloadUrl(result.package.downloadUrl, result.package.id)
      : undefined;
    return {
      ...result,
      package: {
        ...result.package,
        canonicalIdentity: result.package.canonicalIdentity ?? result.package.id,
        ...(downloadUrl ? { downloadUrl } : {}),
      },
    };
  }

  async resolve(spec: string): Promise<ResolvedPackage> {
    const result = await this.resolveIdentity(spec);
    if (result.status === 'not-found-owned') { throw new RegistryPackageError('IDENTITY_RESERVED', `Identity ${spec} is owned by the Registry.`, spec); }
    if (result.status !== 'found') { throw new RegistryPackageError('PACKAGE_NOT_FOUND', `Identity ${spec} was not found in the Registry`, spec); }
    return { ...result.package, source: 'marketplace' };
  }

  async install(pkg: ResolvedPackage, root: string): Promise<InstalledPackage> {
    if (!pkg.downloadUrl) {
      throw new RegistryPackageError('RESOLUTION_FAILED', 'Missing downloadUrl in ResolvedPackage', pkg.id);
    }

    const downloadUrl = this.resolveDownloadUrl(pkg.downloadUrl, pkg.id);
    const resp = await this.fetch(downloadUrl, pkg.id);
    if (!resp.ok) {
      throw new RegistryPackageError(resp.status === 401 || resp.status === 403 ? 'AUTH_FAILED' : 'TRANSPORT_FAILED', `Failed to download ${pkg.id}@${pkg.version}: ${resp.status}`, pkg.id);
    }

    const tarball = Buffer.from(await resp.arrayBuffer());

    // Verify integrity
    if (!pkg.integrity) { throw new RegistryPackageError('INTEGRITY_MISMATCH', `Registry did not provide an integrity pin for ${pkg.id}@${pkg.version}`, pkg.id); }
    const actualIntegrity = `sha256-${createHash('sha256').update(tarball).digest('base64')}`;
    if (actualIntegrity !== pkg.integrity) {
      throw new RegistryPackageError('INTEGRITY_MISMATCH', `Integrity mismatch for ${pkg.id}@${pkg.version}`, pkg.id);
    }

    // Extract to node_modules (write tarball to temp file first — tar requires a path)
    const nodeModulesRoot = path.resolve(root, 'node_modules');
    const packageRoot = path.resolve(nodeModulesRoot, pkg.id);
    if (!packageRoot.startsWith(`${nodeModulesRoot}${path.sep}`)) {
      throw new RegistryPackageError('RESOLUTION_FAILED', 'Registry package identity is not a safe package path', pkg.id);
    }
    const key = `${path.resolve(root)}\0${pkg.id}`;
    const nodeModulesParent = path.dirname(packageRoot);
    const stageName = `.kb-registry-stage-${randomUUID()}`;
    const stagingRoot = path.join(nodeModulesParent, stageName);
    const tmpFile = path.join(nodeModulesParent, `${stageName}.tgz`);
    try {
      await fs.mkdir(nodeModulesParent, { recursive: true });
      const scopeRoot = await fs.realpath(path.resolve(root));
      const nodeModulesStat = await fs.lstat(nodeModulesRoot);
      if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
        throw new RegistryPackageError('RESOLUTION_FAILED', 'Registry package node_modules root must be a real directory', pkg.id);
      }
      const realNodeModulesRoot = await fs.realpath(nodeModulesRoot);
      if (!realNodeModulesRoot.startsWith(`${scopeRoot}${path.sep}`)) {
        throw new RegistryPackageError('RESOLUTION_FAILED', 'Registry package path escapes its scope root', pkg.id);
      }
      let current = nodeModulesRoot;
      for (const segment of path.relative(nodeModulesRoot, nodeModulesParent).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new RegistryPackageError('RESOLUTION_FAILED', 'Registry scoped package path must not traverse symlinks', pkg.id);
        }
      }
      const realNodeModulesParent = await fs.realpath(nodeModulesParent);
      if (realNodeModulesParent !== realNodeModulesRoot &&
        !realNodeModulesParent.startsWith(`${realNodeModulesRoot}${path.sep}`)) {
        throw new RegistryPackageError('RESOLUTION_FAILED', 'Registry package path escapes node_modules', pkg.id);
      }
      await fs.mkdir(stagingRoot, { recursive: false });
      await fs.writeFile(tmpFile, tarball);
      await extract({ file: tmpFile, cwd: stagingRoot, strip: 1, strict: true });
      const packageJsonPath = path.join(stagingRoot, 'package.json');
      let packageJsonStat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        packageJsonStat = await fs.lstat(packageJsonPath);
      } catch {
        throw new RegistryPackageError('PACKAGE_INVALID', 'Registry artifact does not contain package.json', pkg.id);
      }
      if (!packageJsonStat.isFile()) {
        throw new RegistryPackageError('PACKAGE_INVALID', 'Registry artifact package.json must be a regular file', pkg.id);
      }
      let packageJson: { name?: unknown; version?: unknown };
      try {
        packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { name?: unknown; version?: unknown };
      } catch {
        throw new RegistryPackageError('PACKAGE_INVALID', 'Registry artifact package.json is not valid JSON', pkg.id);
      }
      if (packageJson.name !== pkg.id || packageJson.version !== pkg.version) {
        throw new RegistryPackageError(
          'PACKAGE_INVALID',
          `Registry artifact package.json must match ${pkg.id}@${pkg.version}`,
          pkg.id,
        );
      }
      this.pendingInstalls.set(key, { packageRoot, stagingRoot, activated: false });
    } catch (error) {
      await fs.rm(stagingRoot, { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(tmpFile, { force: true });
    }

    return { id: pkg.id, version: pkg.version, packageRoot: stagingRoot, integrity: actualIntegrity };
  }

  /** Resolve path references at the configured source and refuse cross-origin tarball targets. */
  private resolveDownloadUrl(downloadUrl: string, identity: string): string {
    let resolved: URL;
    let source: URL;
    try {
      source = new URL(this.baseUrl);
      resolved = new URL(downloadUrl, source);
    } catch {
      throw new RegistryPackageError('RESOLUTION_FAILED', 'Registry returned an invalid tarball URL', identity);
    }
    if (resolved.origin !== source.origin) {
      throw new RegistryPackageError(
        'RESOLUTION_FAILED', 'Registry tarball URL must use the configured source origin', identity,
      );
    }
    return resolved.toString();
  }

  withShareToken(token: string): RegistryPackageSource {
    return new RegistryPackageSource({
      registryUrl: this.baseUrl,
      authToken: this.authToken,
      shareToken: token,
      signingPublicKey: this.verificationKey,
    });
  }

  async remove(packageId: string, root: string): Promise<void> {
    await fs.rm(path.join(root, 'node_modules', packageId), { recursive: true, force: true });
  }

  async commitInstall(packageId: string, root: string): Promise<void> {
    const key = `${path.resolve(root)}\0${packageId}`;
    const pending = this.pendingInstalls.get(key);
    if (pending?.backupPath) {await fs.rm(pending.backupPath, { recursive: true, force: true });}
    this.pendingInstalls.delete(key);
  }

  async activateInstall(packageId: string, root: string): Promise<string> {
    const key = `${path.resolve(root)}\0${packageId}`;
    const pending = this.pendingInstalls.get(key);
    if (!pending) {throw new RegistryPackageError('PACKAGE_INVALID', 'Registry package staging state is missing', packageId);}
    if (pending.activated) {return pending.packageRoot;}
    const backupPath = path.join(path.dirname(pending.packageRoot), `.${path.basename(pending.packageRoot)}.kb-backup-${randomUUID()}`);
    let hadPrevious = false;
    try {
      await fs.rename(pending.packageRoot, backupPath);
      hadPrevious = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {throw error;}
    }
    if (hadPrevious) {pending.backupPath = backupPath;}
    try {
      await fs.rename(pending.stagingRoot, pending.packageRoot);
    } catch (error) {
      if (hadPrevious) {
        await fs.rename(backupPath, pending.packageRoot);
        delete pending.backupPath;
      }
      throw error;
    }
    pending.activated = true;
    return pending.packageRoot;
  }

  async rollbackInstall(packageId: string, root: string): Promise<void> {
    const key = `${path.resolve(root)}\0${packageId}`;
    const pending = this.pendingInstalls.get(key);
    if (!pending) {return;}
    await fs.rm(pending.activated ? pending.packageRoot : pending.stagingRoot, { recursive: true, force: true });
    if (pending.backupPath) {
      await fs.mkdir(path.dirname(pending.packageRoot), { recursive: true });
      await fs.rename(pending.backupPath, pending.packageRoot);
    }
    this.pendingInstalls.delete(key);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetch(url: string, identity: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.authToken) { headers['Authorization'] = `Bearer ${this.authToken}`; }
    if (this.shareToken) { headers['X-Share-Token'] = this.shareToken; }
    try {
      // Registry credentials are scoped to the configured source origin. Fetch's
      // default redirect handling would forward them to an untrusted Location.
      const response = await globalThis.fetch(url, { headers, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        throw new RegistryPackageError(
          'TRANSPORT_FAILED', 'Registry redirects are not followed for authenticated requests', identity,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof RegistryPackageError) { throw error; }
      throw new RegistryPackageError('TRANSPORT_FAILED', `Registry request failed: ${error instanceof Error ? error.message : String(error)}`, identity);
    }
  }

}

function splitIdentityVersion(spec: string): { identity: string; version?: string } {
  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');
    const versionSeparator = spec.lastIndexOf('@');
    if (slashIndex >= 0 && versionSeparator > slashIndex) {
      return { identity: spec.slice(0, versionSeparator), version: spec.slice(versionSeparator + 1) };
    }
    return { identity: spec };
  }
  const versionSeparator = spec.indexOf('@');
  return versionSeparator > 0
    ? { identity: spec.slice(0, versionSeparator), version: spec.slice(versionSeparator + 1) }
    : { identity: spec };
}
