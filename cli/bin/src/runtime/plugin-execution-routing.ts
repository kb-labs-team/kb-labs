const LOCAL_EXECUTION_MODES = new Set(['in-process', 'subprocess', 'worker-pool']);

/** Explicit local backends execute in this CLI process tree even in secured mode. */
export function shouldExecutePluginViaGateway(
  accessMode: unknown,
  executionMode: unknown,
): boolean {
  return accessMode !== 'local' && !LOCAL_EXECUTION_MODES.has(String(executionMode ?? ''));
}
