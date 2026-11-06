import { describe, it, expect } from 'vitest';
import { mockCLIInput } from '@kb-labs/sdk/testing';
import type { PluginContextV3 } from '@kb-labs/sdk';
import type { CommandFailure } from '@kb-labs/sdk';
import dropCmd from '../../../src/cli/commands/drop.js';

/**
 * `mind index delete` is destructive — it must NOT run without --yes, in any mode. The
 * confirmation gate fires before the engine is ever built, so these assert the
 * software-protocol behaviour without a live platform.
 */
function captureCtx() {
  const calls = { json: [] as unknown[], warn: [] as string[], error: [] as string[] };
  const ctx = {
    host: 'cli',
    cwd: process.cwd(),
    ui: {
      json: (d: unknown) => calls.json.push(d),
      warn: (m: string) => calls.warn.push(m),
      error: (m: string) => calls.error.push(m),
      success: () => {},
      info: () => {},
    },
  } as unknown as PluginContextV3;
  return { ctx, calls };
}

describe('mind index delete — destructive confirmation gate', () => {
  it('blocks with a typed failure and confirmation signal without --yes — no execution', async () => {
    const { ctx, calls } = captureCtx();
    const res = await dropCmd.execute(ctx, mockCLIInput({ flags: { index: 'code', yes: false, json: false } }));
    const failure = res as CommandFailure;
    expect(failure).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CONFIRMATION_REQUIRED', details: { confirmationRequired: 'true' } } });
    expect(calls.warn).toHaveLength(0);
  });

  it('returns the machine-readable confirmationRequired signal in --json mode', async () => {
    const { ctx, calls } = captureCtx();
    const res = await dropCmd.execute(ctx, mockCLIInput({ flags: { index: 'code', yes: false, json: true } }));
    const failure = res as CommandFailure;
    expect(failure).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CONFIRMATION_REQUIRED' } });
    expect(calls.json).toHaveLength(0);
    expect(failure.error.details).toMatchObject({
      confirmationRequired: 'true',
      destructive: 'true',
      action: 'mind index delete',
      severity: 'high',
      confirmWith: '--yes',
    });
    expect(failure).not.toHaveProperty('result');
  });
});
