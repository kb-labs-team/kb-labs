import { loadPlatformConfig } from '@kb-labs/core-runtime';
import {
  resolveCliGatewayAddress,
  resolveCliGatewayTarget,
  type IServiceTransport,
  type CliGatewayAddress,
  type CliGatewayTarget,
} from '@kb-labs/core-platform';

export interface ResolveActiveGatewayOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platformRoot?: string;
  explicitGatewayUrl?: string;
  transport?: Pick<IServiceTransport, 'listenAddress'>;
  configuredGatewayPort?: string;
}

/** Resolve the active platform root, its Gateway address, and its saved Gateway identity. */
export async function resolveActiveGateway({
  cwd,
  env,
  platformRoot: explicitPlatformRoot,
  explicitGatewayUrl,
  transport,
  configuredGatewayPort,
}: ResolveActiveGatewayOptions): Promise<CliGatewayTarget> {
  const platformRoot = await resolvePlatformRoot(cwd, env, explicitPlatformRoot);
  return resolveCliGatewayTarget(platformRoot, {
    gatewayUrl: explicitGatewayUrl,
    gatewayPort: env.GATEWAY_PORT ?? configuredGatewayPort,
    gatewayHost: env.GATEWAY_HOST,
    netOffset: 0,
  }, transport);
}

/** Resolve the same address for service-aware execution without probing a running host. */
export async function resolveActiveGatewayAddress({
  cwd,
  env,
  platformRoot: explicitPlatformRoot,
  explicitGatewayUrl,
  transport,
  configuredGatewayPort,
}: ResolveActiveGatewayOptions): Promise<CliGatewayAddress> {
  const platformRoot = await resolvePlatformRoot(cwd, env, explicitPlatformRoot);
  return resolveCliGatewayAddress(platformRoot, {
    gatewayUrl: explicitGatewayUrl,
    gatewayPort: env.GATEWAY_PORT ?? configuredGatewayPort,
    gatewayHost: env.GATEWAY_HOST,
    netOffset: 0,
  }, transport);
}

async function resolvePlatformRoot(cwd: string, env: NodeJS.ProcessEnv, explicitPlatformRoot?: string): Promise<string> {
  if (explicitPlatformRoot) return explicitPlatformRoot;
  return (await loadPlatformConfig({
    startDir: cwd,
    env,
    loadEnvFile: false,
    projectScope: 'platform',
  })).platformRoot;
}
