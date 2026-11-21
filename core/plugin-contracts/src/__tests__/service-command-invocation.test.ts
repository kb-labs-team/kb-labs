import { describe, expect, it } from 'vitest';
import { normalizeServiceCommandInput } from '../service-command-invocation.js';

const invocation = {
  operationId: 'workflow.cron.set-enabled',
  inputs: [{ name: 'id', type: 'string', required: true, source: { kind: 'positional', index: 0 } }],
  values: { enabled: true },
} as const;

describe('normalizeServiceCommandInput', () => {
  it('maps CLI positional input and MCP named input to the same canonical value', () => {
    expect(normalizeServiceCommandInput(invocation, { argv: ['cron-a'], flags: { json: true } })).toEqual({
      ok: true,
      value: { id: 'cron-a', enabled: true },
    });
    expect(normalizeServiceCommandInput(invocation, { arguments: { id: 'cron-a' } })).toEqual({
      ok: true,
      value: { id: 'cron-a', enabled: true },
    });
  });

  it('returns the same typed input failure for missing and empty MCP values', () => {
    expect(normalizeServiceCommandInput(invocation, { arguments: {} })).toMatchObject({
      ok: false, code: 'KB_RUNTIME_INPUT_INVALID', field: 'id',
    });
    expect(normalizeServiceCommandInput(invocation, { arguments: { id: '' } })).toMatchObject({
      ok: false, code: 'KB_RUNTIME_INPUT_INVALID', field: 'id',
    });
  });

  it('does not accept undeclared MCP presentation flags as invocation inputs', () => {
    expect(normalizeServiceCommandInput(invocation, { arguments: { id: 'cron-a', json: true } })).toMatchObject({
      ok: false, code: 'KB_RUNTIME_INPUT_INVALID', field: 'json',
    });
  });
});
