import type { RouteResult } from '@kb-labs/cli-commands';

type GlobalFlags = { help?: boolean; version?: boolean };

export function resolveProjectScope(
  route: RouteResult,
  global: GlobalFlags,
  cmdPath: string[],
  flags: Record<string, unknown> = {},
  hasRegisteredProject = false,
): 'platform' | 'required' {
  if (global.version || (global.help && cmdPath.length === 0)) {
    return 'platform';
  }
  if (route.type === 'not-found' || route.type === 'ambiguous') {
    return route.type === 'not-found' && cmdPath.length > 0 && hasRegisteredProject
      ? 'required'
      : 'platform';
  }
  if (route.type === 'system-cmd') {
    const requestedScope = declaredScope(route.cmd.flags, flags);
    if (requestedScope) {return requestedScope === 'platform' ? 'platform' : 'required';}
    const scope = typeof route.cmd.scope === 'function'
      ? route.cmd.scope(route.rest, flags)
      : route.cmd.scope;
    return scope === 'platform' ? 'platform' : 'required';
  }
  if (route.type === 'command') {
    const requestedScope = declaredScope(route.command.manifest.flags, flags);
    if (requestedScope) {return requestedScope === 'platform' ? 'platform' : 'required';}
  }
  return 'required';
}

function declaredScope(
  definitions: FlagDefinitionCollection | undefined,
  flags: Record<string, unknown>,
): 'platform' | 'project' | undefined {
  const definition = isFlagDefinitionArray(definitions)
    ? definitions.find((flag) => flag.name === 'scope')
    : definitions?.scope;
  if (!definition?.choices?.includes('platform') || !definition.choices.includes('project')) {return undefined;}
  return flags.scope === 'platform' || flags.scope === 'project' ? flags.scope : undefined;
}

type FlagDefinitionCollection =
  | readonly { name?: string; choices?: readonly string[] }[]
  | Record<string, { choices?: readonly string[] }>;

function isFlagDefinitionArray(
  definitions: FlagDefinitionCollection | undefined,
): definitions is readonly { name?: string; choices?: readonly string[] }[] {
  return Array.isArray(definitions);
}
