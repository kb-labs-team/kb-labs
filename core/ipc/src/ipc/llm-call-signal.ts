/** Attach a host-owned AbortSignal to LLM calls after IPC deserialization. */
export function attachLlmCallAbortSignal(
  adapterName: string,
  methodName: string,
  args: unknown[],
  signal: AbortSignal,
): boolean {
  if (adapterName !== 'llm' || !['complete', 'chatWithTools'].includes(methodName)) {
    return false;
  }

  const options = args[1];
  const target = typeof options === 'object' && options !== null && !Array.isArray(options)
    ? options
    : {};
  Object.defineProperty(target, 'signal', { value: signal, enumerable: false, configurable: true });
  args[1] = target;
  return true;
}
