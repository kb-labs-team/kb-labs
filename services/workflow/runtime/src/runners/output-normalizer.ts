/**
 * Workflow Output Normalizer
 *
 * Converts raw handler return values into workflow step outputs.
 * Ensures consistent Record<string, unknown> shape regardless of
 * handler type (workflow handler, CLI command, builtin) or
 * execution mode (in-process, subprocess, worker-pool, remote).
 *
 * This is the single point of conversion from ExecutionResult.data
 * to step.outputs — no other code should do this transformation.
 */

import { isUxResult } from '@kb-labs/core-platform/ux-result';

function isLegacyCommandResult(value: unknown): value is { ok: boolean; result: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.ok === 'boolean'
    && 'result' in record
    && Object.keys(record).every((key) => key === 'ok' || key === 'result' || key === 'error' || key === 'meta');
}

/**
 * Convert raw handler output to workflow step outputs.
 *
 * Contract:
 * | Handler returns                          | step.outputs              |
 * |------------------------------------------|---------------------------|
 * | { foo: 'bar' }                           | { foo: 'bar' }            |
 * | { ok: true, result: { x: 1 } }           | { x: 1 }                 |
 * | { ok: true, data: { x: 1 } }             | { x: 1 }                 |
 * | { ok: true, result: 'hello' }            | { result: 'hello' }      |
 * | { ok: true, result: undefined }          | {}                        |
 * | { ok: true, result: null }               | {}                        |
 * | { stdout: '...', exitCode: 0, ok: true } | { stdout, exitCode, ok }  |
 * | 'hello' (primitive)                      | { result: 'hello' }      |
 * | 42 (number)                              | { result: 42 }           |
 * | undefined / void                         | {}                        |
 * | null                                     | {}                        |
 */
export function toWorkflowOutputs(data: unknown): Record<string, unknown> {
  if (isUxResult(data) && data.ok) {
    data = data.data;
  } else if (isLegacyCommandResult(data)) {
    data = data.result;
  }

  // Object — use as-is
  if (typeof data === 'object' && data !== null) {
    return data as Record<string, unknown>;
  }

  // Primitive — wrap in { result }
  if (data !== undefined && data !== null) {
    return { result: data };
  }

  // void / undefined / null — empty outputs
  return {};
}
