import { describe, expect, it } from 'vitest';
import type { PermissionSpec } from '@kb-labs/plugin-contracts';
import { DEFAULT_PERMISSIONS } from '@kb-labs/plugin-contracts';
import { assertContainerNetworkPermissionsSupported, createContainerExecutionSpec } from '../container-spec.js';

const githubManifestModule = await import(
  new URL('../../../../plugins/github/src/manifest.ts', import.meta.url).href,
) as { manifest: { permissions: PermissionSpec } };

describe('PermissionSpec container mapping', () => {
  // case: S-244.1
  it('maps static filesystem prefixes and environment grants without implicit access', () => {
    const permissions: PermissionSpec = {
      fs: { read: ['src/**/*.ts'], write: ['/workspace/out'] },
      env: { read: ['PUBLIC_*', 'TOKEN'] },
    };

    expect(createContainerExecutionSpec(permissions, {
      environment: {
        PUBLIC_REGION: 'eu',
        TOKEN: 'secret',
        PRIVATE_KEY: 'hidden',
      },
    })).toEqual({
      mounts: [
        { path: '/workspace/out', access: 'read-write' },
        { path: 'src', access: 'read-only' },
      ],
      environment: { PUBLIC_REGION: 'eu', TOKEN: 'secret' },
    });
  });

  // case: S-244.7
  it('denies filesystem, network, and environment access when omitted', () => {
    expect(createContainerExecutionSpec({}, {
      environment: { SECRET: 'hidden' },
    })).toEqual({ mounts: [], environment: {} });
  });

  // case: S-244.7
  it('refuses every declared network permission before provisioning', () => {
    const cases: PermissionSpec[] = [
      { network: { fetch: ['https://api.example.test'] } },
      { network: { tcp: { connect: ['api.example.test:443'] } } },
      { network: { ws: { connect: ['wss://api.example.test/*'] } } },
    ];

    for (const permissions of cases) {
      expect(() => assertContainerNetworkPermissionsSupported(permissions)).toThrow(
        expect.objectContaining({
          envelope: expect.objectContaining({ code: 'KB_RUNTIME_CONTAINER_NETWORK_UNSUPPORTED' }),
        }),
      );
    }
  });

  // case: S-244.3
  it('accepts shipped default permissions and refuses the shipped GitHub plugin grants', () => {
    expect(() => assertContainerNetworkPermissionsSupported(DEFAULT_PERMISSIONS)).not.toThrow();
    expect(() => assertContainerNetworkPermissionsSupported(githubManifestModule.manifest.permissions)).toThrow(
      expect.objectContaining({
        envelope: expect.objectContaining({ code: 'KB_RUNTIME_CONTAINER_NETWORK_UNSUPPORTED' }),
      }),
    );
  });
});
