/** Resolve the standalone persistence root, while preserving a host-resolved root. */
export function resolveStateDaemonDataRoot(
  platformDataRoot?: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (platformDataRoot) { return platformDataRoot; }
  const configuredRoot = env.KB_STATE_DAEMON_DATA_ROOT?.trim();
  return configuredRoot || undefined;
}
