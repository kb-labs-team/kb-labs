import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';

// Mock packer — avoids execa + node:fs built-ins
vi.mock('../../../src/pack-plugin.js', () => ({
  packPlugin: vi.fn(),
}));

// Mock registry HTTP client (includes resolveRegistryHandle — credential provider chain)
vi.mock('../../../src/registry-http.js', () => ({
  registryPostMultipart: vi.fn(),
  registryPatch: vi.fn(),
  resolveRegistryHandle: vi.fn(),
}));

// Mock fs only for package.json reads
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn() };
});

import * as fsPromises from 'node:fs/promises';
import * as packModule from '../../../src/pack-plugin.js';
import { registryPostMultipart, registryPatch, resolveRegistryHandle } from '../../../src/registry-http.js';
import publishCommand from '../../../src/commands/publish.js';

const mockedReadFile = vi.mocked(fsPromises.readFile);
const mockedPackPlugin = vi.mocked(packModule.packPlugin);
const mockedPostMultipart = vi.mocked(registryPostMultipart);
const mockedPatch = vi.mocked(registryPatch);
const mockedResolveHandle = vi.mocked(resolveRegistryHandle);

const VALID_PKG = JSON.stringify({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Test plugin',
  kb: { manifest: { id: '@kb-labs/test' } },
});

const PUBLISH_RESULT = {
  handle: 'kirill',
  name: 'my-plugin',
  version: '1.0.0',
  visibility: 'public',
  trust: 'trusted',
  installCommand: 'kb marketplace install @kb-labs/test',
  pageUrl: 'https://kblabs.ru/ru/marketplace/kirill/my-plugin',
};

const FAKE_TARBALL = Buffer.from('fake-tarball-bytes');

function createCtxWithHandle(ui?: ReturnType<typeof createCapturedUI>['ui'], cwd?: string) {
  const base = createMockContext({ ui, cwd });
  return Object.assign(base, { handle: 'kirill' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadFile.mockResolvedValue(VALID_PKG as any);
  mockedPackPlugin.mockResolvedValue(FAKE_TARBALL);
  mockedPostMultipart.mockResolvedValue(PUBLISH_RESULT);
  mockedResolveHandle.mockResolvedValue('kirill');
});

describe('marketplace:publish', () => {
  it('PB-01: publishes successfully — chain shows name@version and install command', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toEqual(PUBLISH_RESULT);
    // publish.ts uses ctx.ui.chain() — two items: pack step + publish step
    const chainCall = captured.chain[0];
    expect(chainCall).toBeDefined();
    const successItem = chainCall?.find(item => item.status === 'success');
    expect(successItem?.title).toContain('my-plugin@1.0.0');
    expect(successItem?.title).toContain('published');
    expect(successItem?.summary).toMatchObject({ Visibility: 'public' });
  });

  it('PB-02: --json outputs structured result', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).toEqual(PUBLISH_RESULT);

  });

  it('PB-03: --private passes visibility=private to registry', async () => {
    const { ui } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    await publishCommand.execute(ctx, mockCLIInput({ flags: { private: true } }));

    const fields = mockedPostMultipart.mock.calls[0]?.[2];
    expect(fields).toBeDefined();
    const meta = JSON.parse(fields!.meta!);
    expect(meta.visibility).toBe('private');
  });

  it('PB-04: cannot read package.json — exitCode 1, error shown', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    const { ui, captured } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPackPlugin).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('PB-05: package.json missing name/version — exitCode 1', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ kb: { manifest: true } }) as any);
    const { ui } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPackPlugin).not.toHaveBeenCalled();
  });

  it('PB-06: no kb.manifest or kb.adapter — exitCode 1', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ name: 'x', version: '1.0.0' }) as any);
    const { ui } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(mockedPackPlugin).not.toHaveBeenCalled();
  });

  it('PB-07: --meta-only patches metadata, no tarball upload', async () => {
    mockedPatch.mockResolvedValue(undefined);
    const { ui, captured } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: { metaOnly: true } }));

    expect(result).toBeUndefined();
    expect(mockedPackPlugin).not.toHaveBeenCalled();
    expect(mockedPostMultipart).not.toHaveBeenCalled();
    expect(mockedPatch).toHaveBeenCalled();
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('PB-11: --meta-only uses handle from credential chain, not KB_REGISTRY_AUTHOR_HANDLE', async () => {
    // env var is deliberately absent — handle must come from resolveRegistryHandle()
    delete process.env.KB_REGISTRY_AUTHOR_HANDLE;
    mockedPatch.mockResolvedValue(undefined);
    mockedResolveHandle.mockResolvedValue('from-creds');

    const { ui } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: { metaOnly: true } }));

    expect(result).toBeUndefined();
    expect(mockedResolveHandle).toHaveBeenCalled();
    // URL path must contain the handle resolved from credentials
    const [patchPath] = mockedPatch.mock.calls[0]!;
    expect(patchPath).toContain('from-creds');
  });

  it('PB-08: packPlugin failure — exitCode 1, error shown', async () => {
    mockedPackPlugin.mockRejectedValue(new Error('pnpm pack failed'));
    const { ui, captured } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  // case: S-203.1
  it('keeps publish failure content identical in human and JSON modes', async () => {
    mockedPackPlugin.mockRejectedValue(new Error('package archive failed'));
    const { ui } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const humanResult = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));
    mockedPackPlugin.mockRejectedValue(new Error('package archive failed'));
    const jsonResult = await publishCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    if (!humanResult || !jsonResult || !('error' in humanResult) || !('error' in jsonResult)) {
      throw new Error('publish failure results were not returned');
    }
    expect(jsonResult.error).toMatchObject({
      code: humanResult.error.code,
      message: humanResult.error.message,
      hint: humanResult.error.hint,
      correlationId: ctx.requestId,
    });
    expect(humanResult.error.correlationId).toBe(ctx.requestId);
  });

  it('PB-09: registry HTTP error — exitCode 1, error shown in chain', async () => {
    mockedPostMultipart.mockRejectedValue(new Error('Registry publish failed (422): version exists'));
    const { ui, captured } = createCapturedUI();
    const ctx = createCtxWithHandle(ui);
    const result = await publishCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false });
    // publish.ts uses ctx.ui.chain() for error output — error item has status: 'error'
    const chainCall = captured.chain[0];
    expect(chainCall).toBeDefined();
    const errorItem = chainCall?.find(item => item.status === 'error');
    expect(errorItem?.title).toBe('Publish failed');
  });

  it('PB-10: packPlugin called with resolved plugin dir', async () => {
    const { ui } = createCapturedUI();
    const ctx = createCtxWithHandle(ui, '/workspace');
    await publishCommand.execute(ctx, mockCLIInput({ flags: { path: 'my-plugin' } }));

    expect(mockedPackPlugin).toHaveBeenCalledWith('/workspace/my-plugin');
  });
});
