/** Select the installed host-owned command route only after topology verification and project scope resolution. */
export function shouldUseInstalledProjectRuntime(input: {
  accessMode: unknown;
  projectScope: 'platform' | 'required';
  installationId?: string;
  explicitGatewayUrl?: string;
}): boolean {
  return input.accessMode === 'secured'
    && input.projectScope === 'required'
    && Boolean(input.installationId)
    && input.explicitGatewayUrl === undefined;
}
