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

/**
 * Check if value looks like a plugin CommandResult.
 * CLI command handlers return this shape; workflow handlers return raw data.
 *
 * A shell result also has `exitCode`, so it must not be mistaken for a
 * plugin result even when its process succeeded.
 */
type RuntimeCommandResult = { ok: boolean; result?: unknown; error?: unknown; meta?: Record<string, unknown> };

function isCommandResult(value: unknown): value is RuntimeCommandResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.ok === 'boolean' && !('exitCode' in record);
}

/**
 * Convert raw handler output to workflow step outputs.
 *
 * Contract:
 * | Handler returns                          | step.outputs              |
 * |------------------------------------------|---------------------------|
 * | { foo: 'bar' }                           | { foo: 'bar' }            |
 * | { ok: true, result: { x: 1 } }           | { x: 1 }                 |
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
  // CLI CommandResult — extract the payload
  if (isCommandResult(data)) {
    const inner = data.result;
    if (typeof inner === 'object' && inner !== null) {
      return inner as Record<string, unknown>;
    }
    return inner !== undefined && inner !== null ? { result: inner } : {};
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
