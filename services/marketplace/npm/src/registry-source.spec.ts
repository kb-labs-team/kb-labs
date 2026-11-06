import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { RegistryPackageError, RegistryPackageSource } from './registry-source.js';

describe('RegistryPackageSource', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the registry entity kind when resolving a package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'found',
      package: { id: '@kb-labs/test', packageName: '@kb-labs/test', version: '1.0.0', integrity: 'sha512-fixture', primaryKind: 'plugin', signatureSubject: 'author/test', signature: { algorithm: 'ed25519', value: 'AQ==', signer: 'test', signedAt: '2026-01-01T00:00:00Z', verifiedChecks: ['integrity'] }, downloadUrl: 'https://registry.test/test.tgz' },
    }), { status: 200 })));

    const resolved = await new RegistryPackageSource({ registryUrl: 'https://registry.test', signingPublicKey: 'test-key' })
      .resolveIdentity('@kb-labs/test');

    expect(resolved).toMatchObject({ status: 'found', package: { id: '@kb-labs/test', version: '1.0.0', primaryKind: 'plugin' } });
  });

  it('classifies Registry authentication and transport failures without returning not-found', async () => {
    const source = new RegistryPackageSource({ registryUrl: 'https://registry.test', signingPublicKey: 'test-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(source.resolveIdentity('@kb-labs/private'))
      .rejects.toMatchObject({ code: 'AUTH_FAILED' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network unavailable'); }));
    await expect(source.resolveIdentity('@kb-labs/private'))
      .rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });

  it('checks tarball integrity before extracting any package bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-registry-verification-'));
    const bytes = Buffer.from('tampered archive');
    const expectedIntegrity = `sha256-${createHash('sha256').update('sealed archive').digest('base64')}`;
    const packageRoot = path.join(root, 'node_modules', 'author', 'plugin');
    const source = new RegistryPackageSource({ registryUrl: 'https://registry.test', signingPublicKey: 'configured-public-key' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));

    try {
      await expect(source.install({
        id: 'author/plugin', version: '1.0.0', integrity: expectedIntegrity, source: 'marketplace',
        primaryKind: 'plugin', downloadUrl: 'https://registry.test/plugin.tgz',
      }, root)).rejects.toMatchObject({ name: 'RegistryPackageError', code: 'INTEGRITY_MISMATCH' });
      await expect(fs.access(packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-220.11
  it('restores an existing package when registry archive extraction fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-registry-rollback-'));
    const packageRoot = path.join(root, 'node_modules', 'author', 'broken-adapter');
    const originalManifest = JSON.stringify({ name: 'author/broken-adapter', version: '0.9.0' });
    try {
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'package.json'), originalManifest);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('not a tar archive', { status: 200 })));

      const source = new RegistryPackageSource({ registryUrl: 'https://registry.test', signingPublicKey: 'test-key' });
      await expect(source.install({
        id: 'author/broken-adapter',
        version: '1.0.0',
        integrity: '',
        source: 'marketplace',
        primaryKind: 'adapter',
        downloadUrl: 'https://registry.test/broken-adapter.tgz',
      }, root)).rejects.toThrow();

      expect(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).toBe(originalManifest);
      expect(await fs.readdir(packageRoot)).toEqual(['package.json']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
