import { describe, it, expect } from 'vitest';
import { confirmDestructive, renderDestructiveMessage, type DestructiveAction } from './destructive';

const ACTION: DestructiveAction = {
  action: 'mind index delete',
  resource: 'index "code"',
  effect: 'deletes all vectors',
  severity: 'high',
  reversible: true,
  recovery: 're-index from source',
  blastRadius: { count: 100, unit: 'vectors', scope: 'whole index' },
};

describe('confirmDestructive', () => {
  it('returns null (proceed) when confirmed', () => {
    expect(confirmDestructive({ confirmed: true, action: ACTION })).toBeNull();
  });

  it('blocks with a typed failure for the shared human renderer when not confirmed', () => {
    const result = confirmDestructive({ confirmed: false, action: ACTION });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_CONFIRMATION_REQUIRED',
        kind: 'validation',
        details: { confirmationRequired: 'true', destructive: 'true', action: 'mind index delete' },
      },
    });
    expect(result).not.toHaveProperty('result');
  });

  it('returns a machine-readable signal in json mode (agent sees blast radius)', () => {
    const res = confirmDestructive({ confirmed: false, action: ACTION });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_CONFIRMATION_REQUIRED' },
    });
    const details = res!.error.details ?? {};
    expect(details).toMatchObject({
      confirmationRequired: 'true',
      destructive: 'true',
      irreversible: 'false',
      reversible: 'true',
      severity: 'high',
      action: 'mind index delete',
      resource: 'index "code"',
      confirmWith: '--yes',
      blastRadiusCount: '100',
      blastRadiusUnit: 'vectors',
      blastRadiusScope: 'whole index',
      recovery: 're-index from source',
    });
    expect(res!.error.message).toContain('mind index delete');
  });

  it('marks irreversible actions and omits a recovery field when none', () => {
    const res = confirmDestructive({
      confirmed: false,
      action: { ...ACTION, reversible: false, recovery: undefined },
    });
    expect(res).not.toBeNull();
    const error = res!.error;
    expect(error.code).toBe('KB_RUNTIME_CONFIRMATION_REQUIRED');
    if (error.code !== 'KB_RUNTIME_CONFIRMATION_REQUIRED') throw new Error('Unexpected confirmation error code');
    expect(Object.entries(error.details ?? {})).toContainEqual(['irreversible', 'true']);
    expect(error.details && 'recovery' in error.details).toBe(false);
  });

  it('returns a failure for the shared renderer without a UI context', () => {
    const result = confirmDestructive({ confirmed: false, action: ACTION });
    expect(result?.error).toMatchObject({ code: 'KB_RUNTIME_CONFIRMATION_REQUIRED', hint: expect.any(String) });
  });
});

describe('renderDestructiveMessage', () => {
  it('leads with [severity] + recovery when reversible', () => {
    const m = renderDestructiveMessage(ACTION);
    expect(m).toContain('[high]');
    expect(m).not.toContain('IRREVERSIBLE');
    expect(m).toContain('Recovery: re-index from source');
    expect(m).toContain('Confirm with --yes');
  });

  it('leads with IRREVERSIBLE + "No recovery" when not reversible', () => {
    const m = renderDestructiveMessage({ ...ACTION, reversible: false, recovery: undefined });
    expect(m).toContain('⚠ IRREVERSIBLE [high]');
    expect(m).toContain('No recovery — data is permanently lost');
  });

  it('renders blast radius (count · unit · scope)', () => {
    expect(renderDestructiveMessage(ACTION)).toContain('100 vectors · whole index');
  });

  it('honours a custom confirm flag', () => {
    expect(renderDestructiveMessage({ ...ACTION, confirmFlag: '--force' })).toContain('Confirm with --force');
  });
});
