import { describe, it, expect } from 'vitest';
import { mockCLIInput } from '@kb-labs/sdk/testing';
import type { PluginContextV3 } from '@kb-labs/sdk';
import type { CommandFailure } from '@kb-labs/sdk';
import syncDeleteCmd from '../../../src/cli/commands/sync-delete.js';

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

describe('mind sync delete — destructive confirmation gate', () => {
  it('errors when no paths are given (before any confirmation)', async () => {
    const { ctx, calls } = captureCtx();
    const res = await syncDeleteCmd.execute(ctx, mockCLIInput({ argv: [], flags: { index: 'code', yes: false, json: false } }));
    expect(res).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    expect(calls.error).toHaveLength(0);
  });

  it('blocks deletion without --yes and returns the typed confirmation signal', async () => {
    const { ctx, calls } = captureCtx();
    const res = await syncDeleteCmd.execute(
      ctx,
      mockCLIInput({ argv: ['src/a.ts', 'src/b.ts'], flags: { index: 'code', yes: false, json: false } }),
    );
    const failure = res as CommandFailure;
    expect(failure).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CONFIRMATION_REQUIRED', details: { confirmationRequired: 'true' } } });
    expect(calls.warn).toHaveLength(0);
  });

  it('emits the confirmationRequired signal in --json mode', async () => {
    const { ctx, calls } = captureCtx();
    const failure = await syncDeleteCmd.execute(
      ctx,
      mockCLIInput({ argv: ['src/a.ts'], flags: { index: 'code', yes: false, json: true } }),
    ) as CommandFailure;
    expect(calls.json).toHaveLength(0);
    expect(failure.error.details).toMatchObject({
      confirmationRequired: 'true',
      destructive: 'true',
      action: 'mind sync delete',
      severity: 'medium',
    });
    expect(failure).not.toHaveProperty('result');
  });
});
