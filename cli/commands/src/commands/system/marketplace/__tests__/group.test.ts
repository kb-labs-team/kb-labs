import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { marketplaceGroup } from '../index.js';

let isolatedHome: string;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (isolatedHome) { await fs.rm(isolatedHome, { recursive: true, force: true }); }
});

describe('marketplace system command group', () => {
  it('renders the typed service error when an install request fails', async () => {
    isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-command-home-'));
    vi.stubEnv('HOME', isolatedHome);
    vi.stubEnv('KB_HOME', path.join(isolatedHome, '.kb'));
    vi.stubEnv('KB_PLATFORM_ROOT', isolatedHome);
    const envelope = createErrorEnvelope('KB_PLUGIN_INTEGRITY_MISMATCH', {
      details: {
        plugin: '@kb-labs/commit',
        expected: 'sha512-registry-pin',
        actual: 'sha256-package-json-fallback',
      },
      cause: 'The package integrity did not match the registry pin.',
    });
    vi.stubEnv('KB_GATEWAY_URL', 'http://127.0.0.1:9600');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: envelope }), { status: 500 })));
    const json = vi.fn();
    const ctx = createMockContext({ ui: { json } });
    const install = marketplaceGroup.commands.find(command => command.name === 'install');
    if (!install) { throw new Error('Marketplace install command is missing from its built-in group.'); }

    const exitCode = await install.run(ctx, ['@kb-labs/commit'], { scope: 'platform', json: true });

    expect(exitCode).toBeGreaterThan(0);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: envelope.code, message: envelope.message, hint: envelope.hint }),
    }));
  });
});
