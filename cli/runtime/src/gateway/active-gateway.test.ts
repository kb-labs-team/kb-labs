import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toErrorEnvelope } from '@kb-labs/core-platform';

const mocks = vi.hoisted(() => ({
  loadPlatformConfig: vi.fn(),
  session: null as null | { gatewayUrl: string },
}));

vi.mock('@kb-labs/core-runtime', () => ({ loadPlatformConfig: mocks.loadPlatformConfig }));
vi.mock('@kb-labs/sdk/gateway', () => ({
  SessionManager: class {
    async load() { return mocks.session; }
    isExpired() { return false; }
    getFilePath() { return '/tmp/session.json'; }
  },
}));
vi.mock('@kb-labs/sdk/gateway', () => ({
  CredentialsManager: class { async load() { return null; } },
}));

import { resolveActiveGateway } from './active-gateway.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kb-active-gateway-'));
  mocks.loadPlatformConfig.mockReset().mockResolvedValue({ platformRoot: root });
  mocks.session = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('resolveActiveGateway', () => {
  // case: S-203.16
  it('rejects an invalid GATEWAY_PORT before selecting the installed receipt URL', async () => {
    await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
    await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      installationId: 'installed-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
    }));

    let failure: unknown;
    try {
      await resolveActiveGateway({ cwd: root, env: { GATEWAY_PORT: 'not-a-port' } });
    } catch (error) {
      failure = toErrorEnvelope(error);
    }
    expect(failure).toMatchObject({
      code: 'KB_CONFIG_INVALID',
      details: { path: 'GATEWAY_PORT' },
      hint: expect.any(String),
    });
  });

  it('uses the receipt URL even when ambient dev network variables are set', async () => {
    await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
    await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      installationId: 'installed-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { installationId: 'installed-b' } }), { status: 200 })));
    const env = { GATEWAY_PORT: '4300', GATEWAY_HOST: '127.0.0.2', KB_NET_OFFSET: '100' };

    await expect(resolveActiveGateway({ cwd: root, env })).resolves.toMatchObject({
      gatewayUrl: 'http://127.0.0.1:4250', installationId: 'installed-b',
    });
    expect(mocks.loadPlatformConfig).toHaveBeenCalledWith({
      startDir: root, env, loadEnvFile: false, projectScope: 'platform',
    });
  });

  it('uses the configured service address when there is no local installation receipt', async () => {
    mocks.session = { gatewayUrl: 'https://team-gateway.example.test' };

    await expect(resolveActiveGateway({
      cwd: root,
      env: { GATEWAY_PORT: '4300', KB_NET_OFFSET: '100' },
    })).resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:4300' });
  });

  it('uses the configured listener port when no receipt exists', async () => {
    await expect(resolveActiveGateway({ cwd: root, env: { GATEWAY_PORT: '4300', KB_NET_OFFSET: '20' } }))
      .resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:4300', platformRoot: root });
  });

  it('uses an explicit command gateway URL before the installed receipt', async () => {
    await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
    await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      installationId: 'installed-b', verification: { hostHealthUrl: 'http://127.0.0.1:4250/health' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { installationId: 'installed-b' } }), { status: 200 })));

    await expect(resolveActiveGateway({
      cwd: root,
      env: {},
      explicitGatewayUrl: 'http://127.0.0.1:4399',
    })).resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:4399' });
  });

  it('does not derive CLI addresses from KB_NET_OFFSET', async () => {
    await expect(resolveActiveGateway({
      cwd: root,
      env: { GATEWAY_PORT: '4300', KB_NET_OFFSET: '20' },
    })).resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:4300' });
  });

  it('does not treat an ambient Gateway URL as the command address', async () => {
    await expect(resolveActiveGateway({
      cwd: root,
      env: { KB_GATEWAY_URL: 'http://127.0.0.1:4399', GATEWAY_PORT: '4300' },
    })).resolves.toMatchObject({ gatewayUrl: 'http://127.0.0.1:4300' });
  });
});
