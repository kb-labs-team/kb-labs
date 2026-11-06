/**
 * @module @kb-labs/marketplace-npm/registry-source
 * KB Labs Registry PackageSource implementation.
 * Resolves/installs packages from the KB Registry (kb:handle/name spec).
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { extract } from 'tar';
import * as os from 'node:os';
import type { MarketplaceSource, ResolvedPackage, InstalledPackage } from '@kb-labs/marketplace-contracts';

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
  private readonly pendingInstalls = new Map<string, { packageRoot: string; backupPath?: string }>();

  constructor(opts: RegistrySourceOptions) {
    this.baseUrl = opts.registryUrl.replace(/\/$/, '');
    this.authToken = opts.authToken;
    this.shareToken = opts.shareToken;
    if (!opts.signingPublicKey) {
      throw new RegistryPackageError('KB_CONFIG_SECRET_MISSING', 'Registry signing public key is required by marketplace.sources.', 'unknown');
    }
    this.verificationKey = opts.signingPublicKey;
  }

  async resolveIdentity(identity: string) {
    const response = await this.fetch(`${this.baseUrl}/api/v1/resolve?identity=${encodeURIComponent(identity)}`, identity);
    if (!response.ok) {
      throw new RegistryPackageError(response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'RESOLUTION_FAILED', `Registry identity resolution failed with HTTP ${response.status}`, identity);
    }
    const result = await response.json() as import('@kb-labs/marketplace-contracts').MarketplaceSourceResolution;
    if (result.status !== 'found') { return result; }
    return result;
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

    const resp = await this.fetch(pkg.downloadUrl, pkg.id);
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
    const packageRoot = path.join(root, 'node_modules', pkg.id);
    const key = `${path.resolve(root)}\0${pkg.id}`;
    const backupPath = path.join(os.tmpdir(), `kb-registry-before-${createHash('sha256').update(key).digest('hex')}`);
    await fs.rm(backupPath, { recursive: true, force: true });
    let hadPrevious = false;
    try {
      await fs.access(packageRoot);
      await fs.cp(packageRoot, backupPath, { recursive: true, dereference: false });
      hadPrevious = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {throw error;}
    }
    this.pendingInstalls.set(key, { packageRoot, ...(hadPrevious ? { backupPath } : {}) });
    const tmpFile = path.join(os.tmpdir(), `kb-registry-${Date.now()}.tgz`);
    try {
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(tmpFile, tarball);
      await extract({ file: tmpFile, cwd: packageRoot, strip: 1 });
    } catch (error) {
      try {
        await this.rollbackInstall(pkg.id, root);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Marketplace could not restore package files after installing ${pkg.id}.`);
      }
      throw error;
    } finally {
      await fs.rm(tmpFile, { force: true });
    }

    return { id: pkg.id, version: pkg.version, packageRoot, integrity: actualIntegrity };
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

  async rollbackInstall(packageId: string, root: string): Promise<void> {
    const key = `${path.resolve(root)}\0${packageId}`;
    const pending = this.pendingInstalls.get(key);
    if (!pending) {return;}
    await fs.rm(pending.packageRoot, { recursive: true, force: true });
    if (pending.backupPath) {
      await fs.mkdir(path.dirname(pending.packageRoot), { recursive: true });
      await fs.cp(pending.backupPath, pending.packageRoot, { recursive: true, dereference: false });
      await fs.rm(pending.backupPath, { recursive: true, force: true });
    }
    this.pendingInstalls.delete(key);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetch(url: string, identity: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.authToken) { headers['Authorization'] = `Bearer ${this.authToken}`; }
    if (this.shareToken) { headers['X-Share-Token'] = this.shareToken; }
    try {
      return await globalThis.fetch(url, { headers });
    } catch (error) {
      throw new RegistryPackageError('TRANSPORT_FAILED', `Registry request failed: ${error instanceof Error ? error.message : String(error)}`, identity);
    }
  }

}
