import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IServiceTransport } from './adapters/service-transport.js';
import { ServicePortConfigError } from './errors.js';
import { getHostServiceAddress } from './host-service-address.js';
import { createErrorEnvelope } from './error-envelope/catalog.js';
import { ErrorEnvelopeError } from './error-envelope/types.js';
import { decodeUxSuccessResult } from './ux-result/index.js';

/** Canonical listener settings for the Gateway service across all launchers. */
export const GATEWAY_SERVICE_NETWORK = {
  serviceId: 'gateway',
  portEnvVar: 'GATEWAY_PORT',
  defaultPort: 4000,
  hostEnvVar: 'GATEWAY_HOST',
  defaultHost: '0.0.0.0',
} as const;

/** Network inputs needed by both the daemon binder and address consumers. */
export interface ServiceNetworkSettings {
  serviceId: string;
  portEnvVar?: string;
  portEnvValue?: string;
  defaultPort?: number;
  hostEnvValue?: string;
  defaultHost?: string;
}

export interface ResolvedServiceListenAddress {
  port: number;
  host: string;
}

export interface GatewayServiceAddressOptions {
  gatewayUrl?: string;
  gatewayPort?: string;
  gatewayHost?: string;
  netOffset: number;
}

export interface CliGatewayAddress {
  gatewayUrl: string;
  platformRoot?: string;
}

export interface CliGatewayTarget {
  gatewayUrl: string;
  platformRoot?: string;
  installationId?: string;
}

/** Resolve the selected Gateway URL without requiring a running service. */
export async function resolveCliGatewayAddress(
  platformRoot: string | undefined,
  options: GatewayServiceAddressOptions,
  transport?: Pick<IServiceTransport, 'listenAddress'>,
): Promise<CliGatewayAddress> {
  const { gatewayUrl } = await selectCliGateway(platformRoot, options, transport);
  return { gatewayUrl, ...(platformRoot ? { platformRoot } : {}) };
}

/** Resolve and verify the Gateway selected by the active installed platform root. */
export async function resolveCliGatewayTarget(
  platformRoot: string | undefined,
  options: GatewayServiceAddressOptions,
  transport?: Pick<IServiceTransport, 'listenAddress'>,
): Promise<CliGatewayTarget> {
  const { gatewayUrl, installation } = await selectCliGateway(platformRoot, options, transport);

  if (platformRoot && installation?.id) {
    let response: Response;
    try {
      response = await fetch(`${gatewayUrl}/health/identity`, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new ErrorEnvelopeError(createErrorEnvelope('KB_HOST_UNREACHABLE', {
        details: { address: new URL(gatewayUrl).origin },
        hint: `Run "kb-create start --platform-root ${platformRoot}" and retry the command.`,
      }));
    }
    let identity: { installationId?: string } = {};
    if (response.ok) {
      try {
        identity = decodeUxSuccessResult<{ installationId?: string }>(await response.json());
      } catch {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_HOST_IDENTITY_MISMATCH', {
          details: {
            expectedInstallationId: installation.id,
            actualInstallationId: 'unknown',
            expectedPlatformRoot: platformRoot,
          },
        }));
      }
    }
    if (identity.installationId !== installation.id) {
      throw new ErrorEnvelopeError(createErrorEnvelope('KB_HOST_IDENTITY_MISMATCH', {
        details: {
          expectedInstallationId: installation.id,
          actualInstallationId: identity.installationId ?? 'unknown',
          expectedPlatformRoot: platformRoot,
        },
      }));
    }
  }

  return {
    gatewayUrl,
    ...(platformRoot ? { platformRoot } : {}),
    ...(installation?.id ? { installationId: installation.id } : {}),
  };
}

async function selectCliGateway(
  platformRoot: string | undefined,
  options: GatewayServiceAddressOptions,
  transport?: Pick<IServiceTransport, 'listenAddress'>,
): Promise<{ gatewayUrl: string; installation?: { id: string; gatewayUrl: string } }> {
  validateConfiguredGatewayPort(options);
  if (options.gatewayUrl) {
    return { gatewayUrl: resolveGatewayServiceAddress(undefined, options) };
  }
  const installation = platformRoot ? await readInstalledPlatformIdentity(platformRoot) : undefined;
  if (installation) return { gatewayUrl: installation.gatewayUrl, installation };
  validateConfiguredGatewayPort(options);
  const gatewayUrl = resolveGatewayServiceAddress(transport, options);
  return { gatewayUrl, installation };
}

export async function readInstalledPlatformIdentity(platformRoot: string): Promise<{ id: string; gatewayUrl: string } | undefined> {
  const receiptPath = path.join(platformRoot, '.kb', 'v2', 'receipt.json');
  let receipt: { installationId?: string; verification?: { hostHealthUrl?: string } };
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as typeof receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_INSTALL_RECEIPT_UNAVAILABLE', {
      cause: `The active platform receipt at ${receiptPath} could not be parsed.`,
      hint: `Run "kb-create update --platform-root ${platformRoot}" or reinstall the platform, then retry the command.`,
    }));
  }
  if (!receipt.installationId || !receipt.verification?.hostHealthUrl) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_INSTALL_RECEIPT_UNAVAILABLE', {
      cause: `The active platform receipt at ${receiptPath} has no installationId or verified Gateway URL.`,
      hint: `Run "kb-create update --platform-root ${platformRoot}" or reinstall the platform, then retry the command.`,
    }));
  }
  const healthUrl = new URL(receipt.verification.hostHealthUrl);
  healthUrl.pathname = healthUrl.pathname.replace(/\/?health$/, '');
  healthUrl.search = '';
  healthUrl.hash = '';
  return { id: receipt.installationId, gatewayUrl: healthUrl.toString().replace(/\/$/, '') };
}

/** Resolve the HTTP URL that CLI children use to reach the Gateway listener. */
export function resolveGatewayServiceAddress(
  transport: Pick<IServiceTransport, 'listenAddress'> | undefined,
  options: GatewayServiceAddressOptions,
): string {
  validateConfiguredGatewayPort(options);
  if (options.gatewayUrl) {
    return getHostServiceAddress('gateway', { KB_GATEWAY_URL: options.gatewayUrl });
  }
  const address = resolveServiceListenAddress(transport, {
    serviceId: GATEWAY_SERVICE_NETWORK.serviceId,
    portEnvVar: GATEWAY_SERVICE_NETWORK.portEnvVar,
    portEnvValue: options.gatewayPort,
    defaultPort: GATEWAY_SERVICE_NETWORK.defaultPort,
    hostEnvValue: options.gatewayHost,
    defaultHost: GATEWAY_SERVICE_NETWORK.defaultHost,
  }, options.netOffset);
  return `http://127.0.0.1:${address.port}`;
}

function validateConfiguredGatewayPort(options: GatewayServiceAddressOptions): void {
  if (options.gatewayPort === undefined) return;
  resolveServiceListenAddress(undefined, {
    serviceId: GATEWAY_SERVICE_NETWORK.serviceId,
    portEnvVar: GATEWAY_SERVICE_NETWORK.portEnvVar,
    portEnvValue: options.gatewayPort,
    defaultPort: GATEWAY_SERVICE_NETWORK.defaultPort,
  }, 0);
}

/**
 * Resolve the exact service bind address used by `@kb-labs/shared-daemon`.
 * Transport addresses already include their network offset. Port environment
 * values and module defaults receive the offset here, matching daemon startup.
 */
export function resolveServiceListenAddress(
  transport: Pick<IServiceTransport, 'listenAddress'> | undefined,
  settings: ServiceNetworkSettings,
  netOffset: number,
): ResolvedServiceListenAddress {
  const address = transport?.listenAddress?.(settings.serviceId);
  const port = address && 'port' in address
    ? address.port
    : resolveConfiguredPort(settings, netOffset);
  const transportHost = address && 'host' in address ? address.host : undefined;
  const host = settings.hostEnvValue || transportHost || settings.defaultHost || '0.0.0.0';
  return { port, host };
}

function resolveConfiguredPort(settings: ServiceNetworkSettings, netOffset: number): number {
  const envVar = settings.portEnvVar ?? `service.${settings.serviceId}.port`;
  const configuredPort = settings.portEnvValue;
  let port: number | undefined;
  if (configuredPort !== undefined) {
    if (!/^\d+$/.test(configuredPort)) {
      throw new ServicePortConfigError(envVar, 'must be an integer from 1 through 65535');
    }
    port = Number(configuredPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new ServicePortConfigError(envVar, 'must be an integer from 1 through 65535');
    }
  } else {
    port = settings.defaultPort;
  }
  if (port === undefined) {
    throw new Error(
      `Service transport has no listen address for "${settings.serviceId}" and no port was configured.`,
    );
  }
  const resolvedPort = port + netOffset;
  if (!Number.isSafeInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    throw new ServicePortConfigError(
      envVar,
      `must resolve to an integer from 1 through 65535 after applying the network offset (resolved ${resolvedPort})`,
    );
  }
  return resolvedPort;
}
