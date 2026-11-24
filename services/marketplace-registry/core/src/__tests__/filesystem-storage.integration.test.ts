import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter } from '@kb-labs/adapters-fs';
import { InMemoryCache } from '@kb-labs/core-platform/inmemory';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import { RegistryService } from '../registry-service.js';

const makeService = (storageRoot: string, privatePem: string) => new RegistryService({
  storage: createAdapter({ baseDir: storageRoot }),
  cache: new InMemoryCache(),
  logger: new NoOpLogger(),
  baseUrl: 'https://registry.test/api/v1/marketplace-registry',
  signingPrivateKey: privatePem,
});

const createSigningKeys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  };
};

const createPackageFixture = () => {
  const packageName = '@e2e/registry-smoke-fixture';
  const version = '1.0.0';
  const identity = packageName;
  const tarball = Buffer.from('filesystem-backed registry fixture');
  const integrity = `sha256-${createHash('sha256').update(tarball).digest('base64')}`;
  return {
    packageName,
    version,
    identity,
    tarball,
    integrity,
    publishRequest: {
      meta: { name: packageName, version, identity, description: 'Registry persistence fixture' },
      visibility: 'public' as const,
      primaryKind: 'plugin' as const,
    },
  };
};

const verifySignature = (integrity: string, packageName: string, version: string, signature: { value: string } | undefined, publicKey: KeyObject) => {
  if (!signature) {
    throw new Error('Persisted signature is missing');
  }
  const signedPayload = Buffer.from(JSON.stringify({
    integrity,
    pkg: `e2everify/${packageName}@${version}`,
  }));
  expect(cryptoVerify(null, signedPayload, publicKey, Buffer.from(signature.value, 'base64'))).toBe(true);
};

describe('Registry filesystem storage', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  // case: S-324.1
  it('publishes and resolves a signed public package from filesystem storage', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'kb-registry-fs-'));
    const storageRoot = join(tempRoot, 'registry-storage');
    const { privatePem, publicKey } = createSigningKeys();
    const fixture = createPackageFixture();
    const service = makeService(storageRoot, privatePem);
    const published = await service.publish(fixture.tarball, fixture.publishRequest, 'e2everify', 'ns-e2e-verify');
    expect(published.trust).toBe('trusted');
    expect(published.signature?.algorithm).toBe('ed25519');

    const resolution = await service.resolveIdentity(fixture.identity);
    expect(resolution).toMatchObject({
      status: 'found',
      package: { version: fixture.version, integrity: fixture.integrity, signatureSubject: `e2everify/${fixture.packageName}` },
    });
    if (resolution.status !== 'found') {
      throw new Error('Persisted package did not resolve');
    }

    const downloaded = await service.getTarball('e2everify', fixture.packageName, fixture.version);
    expect(downloaded.tarball).toEqual(fixture.tarball);
    expect(downloaded.signature?.algorithm).toBe('ed25519');
    expect(`sha256-${createHash('sha256').update(downloaded.tarball).digest('base64')}`).toBe(fixture.integrity);
    verifySignature(fixture.integrity, fixture.packageName, fixture.version, downloaded.signature, publicKey);
  });

  // case: S-324.2
  it('preserves signed package metadata and tarball across service recreation', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'kb-registry-fs-'));
    const storageRoot = join(tempRoot, 'registry-storage');
    const { privatePem, publicKey } = createSigningKeys();
    const fixture = createPackageFixture();
    const firstService = makeService(storageRoot, privatePem);
    await firstService.publish(fixture.tarball, fixture.publishRequest, 'e2everify', 'ns-e2e-verify');

    const recreatedService = makeService(storageRoot, privatePem);
    const resolution = await recreatedService.resolveIdentity(fixture.identity);
    expect(resolution).toMatchObject({
      status: 'found',
      package: { version: fixture.version, integrity: fixture.integrity },
    });
    const downloaded = await recreatedService.getTarball('e2everify', fixture.packageName, fixture.version);
    expect(downloaded.tarball).toEqual(fixture.tarball);
    verifySignature(fixture.integrity, fixture.packageName, fixture.version, downloaded.signature, publicKey);
  });

  // case: S-324.3
  it('rejects path traversal before writing outside the filesystem storage root', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'kb-registry-fs-'));
    const storageRoot = join(tempRoot, 'registry-storage');
    const { privatePem } = createSigningKeys();
    const fixture = createPackageFixture();
    const service = makeService(storageRoot, privatePem);

    await expect(service.publish(fixture.tarball, {
      ...fixture.publishRequest,
      meta: { ...fixture.publishRequest.meta, name: '../outside' },
    }, 'e2everify', 'ns-e2e-verify')).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await expect(access(join(tempRoot, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
