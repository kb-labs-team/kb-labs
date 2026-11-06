/** Show platform adapters and their built-in fallback. */

import { ADAPTER_DEFAULTS, toErrorEnvelope, ErrorEnvelopeError, type AdapterSlot, type ErrorEnvelope } from '@kb-labs/core-platform';
import { adapterPackageName, adapterPackageRoot, configuredAdapterForSlot, isWorkspaceDevelopmentMode, loadCatalogAdapterEntries, loadPlatformConfig, projectEffectiveAdapterImplementation, resolveDiscoveredAdapterDefaults, type AdaptersConfig } from '@kb-labs/core-runtime';
import { isEnvReference } from '@kb-labs/core-config';
import { resolvePlatformDataPath, resolvePlatformDataRoot } from '@kb-labs/core-project-registry';
import { defineSystemCommand, throwSystemCataloguedError, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { generateExamples } from '../../../utils/generate-examples';
import { readGatewaySuccessData } from '@kb-labs/sdk/gateway';
import { resolveActiveGateway } from '@kb-labs/cli-runtime/gateway';
import { projectNetworkRequirement } from './list-projection.js';
import { requireResolvedCatalog } from '../../../registry/discovery-state.js';

type AdapterRow = {
  slot: string;
  implementation: string | null;
  mode: 'real' | 'inmemory' | 'noop' | 'unconfigured' | 'degraded' | 'unknown';
  baseDir?: string;
  networkRequired: boolean;
  requiresConfiguration?: boolean;
  credentialsStatus?: 'configured' | 'missing';
  missingCredentials?: string[];
  reason?: 'load-failed';
  correlationId?: string;
  action?: { id: string; label: string; command: string };
  runtimeStatus?: 'known' | 'unknown';
  runtimeReason?: string;
};

type HostAdapterStatus = {
  slot: string;
  mode: 'real' | 'inmemory' | 'noop' | 'degraded';
  implementation: string;
  configuredPackage?: string;
  reason?: 'not-configured' | 'load-failed';
  correlationId?: string;
  action?: { id: string; label: string; command: string };
};

type ListResult = CommandResult & { adapters?: AdapterRow[]; projectRoot?: string; envelope?: ErrorEnvelope };

export const adapterList = defineSystemCommand<{ json: { type: 'boolean'; description?: string } }, ListResult>({
  name: 'list',
  scope: 'platform',
  jsonTest: { safeArgs: [] },
  description: 'List effective platform adapters',
  longDescription: 'Shows platform bindings, installed defaults, and built-in fallbacks without contacting adapter services.',
  category: 'adapter',
  examples: generateExamples('adapter list', 'kb', [{ flags: { json: true }, description: '' }]),
  flags: { json: { type: 'boolean', description: 'Output machine-readable JSON' } },
  analytics: { command: 'adapter.list' },
  async handler(ctx) {
    let loaded: Awaited<ReturnType<typeof loadPlatformConfig>>;
    try {
      const catalog = requireResolvedCatalog();
      loaded = await loadPlatformConfig({ moduleUrl: import.meta.url, startDir: getContextCwd(ctx), loadEnvFile: false, projectScope: 'platform', catalog });
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      throwSystemCataloguedError(envelope);
    }
    const config = loaded.platformConfig;
    const configuredPackages = Object.entries(config.adapters ?? {}).flatMap(([slot, value]) =>
      (Array.isArray(value) ? value : [value]).filter((modulePath): modulePath is string => typeof modulePath === 'string')
        .map((modulePath) => ({ packageName: modulePath.split('/').slice(0, 2).join('/'), slot })),
    );
    const workspaceOptions = isWorkspaceDevelopmentMode(loaded)
      ? { development: true as const, workspaceRoot: loaded.projectRoot ?? getContextCwd(ctx), configuredPackages }
      : { development: false as const, configuredPackages };
    const discovered = await loadCatalogAdapterEntries(loaded.catalog.adapters(), workspaceOptions);
    const resolvedDefaults = resolveDiscoveredAdapterDefaults({
      adapters: { ...(config.adapters ?? {}) },
      adapterOptions: Object.fromEntries(Object.entries(config.adapterOptions ?? {})),
    }, discovered, loaded.projectRoot ?? getContextCwd(ctx));
    const effectiveAdapters = resolvedDefaults.adapters as AdaptersConfig;
    const effectiveAdapterOptions = resolvedDefaults.adapterOptions as Record<string, unknown>;
    const platformDataRoot = await resolvePlatformDataRoot(loaded.platformRoot, isWorkspaceDevelopmentMode(loaded));
    const startHostCommand = `kb-create start --platform-root ${JSON.stringify(loaded.platformRoot)}`;
    let hostStatuses = new Map<string, HostAdapterStatus>();
    let runtimeStatus: 'known' | 'unknown' = 'unknown';
    let runtimeReason = 'Host runtime status could not be read.';
    try {
      const gateway = await resolveActiveGateway({ cwd: getContextCwd(ctx), env: process.env, platformRoot: loaded.platformRoot });
      const response = await ctx.runtime.fetch(`${gateway.gatewayUrl}/health/adapters`);
      if (!response.ok) {
        runtimeReason = `Host returned HTTP ${response.status} for adapter health.`;
      } else {
        const statuses = await readGatewaySuccessData<HostAdapterStatus[]>(response, {
          operation: 'List adapter health',
          gatewayUrl: gateway.gatewayUrl,
        });
        hostStatuses = new Map(statuses.map((status) => [status.slot, status]));
        runtimeStatus = 'known';
        runtimeReason = '';
      }
    } catch (error) {
      if (error instanceof ErrorEnvelopeError && error.envelope.code !== 'KB_HOST_UNREACHABLE') {
        throwSystemCataloguedError(error.envelope);
      }
      runtimeReason = error instanceof Error ? error.message : String(error);
    }
    const rows = (Object.keys(ADAPTER_DEFAULTS) as AdapterSlot[]).map((slot): AdapterRow => {
      const configuredAdapter = configuredAdapterForSlot(slot, effectiveAdapters);
      const configKey = configuredAdapter?.key;
      const configured = configuredAdapter?.value;
      const configuredPackage = typeof configured === 'string' ? configured : Array.isArray(configured) ? configured[0] : undefined;
      const packageId = configuredPackage ? configuredPackage : undefined;
      const option = configKey ? effectiveAdapterOptions[configKey] : undefined;
      const schema = packageId ? discovered.get(adapterPackageRoot(packageId))?.module.manifest : undefined;
      const configSchema = schema && typeof schema === 'object' && 'configSchema' in schema &&
        schema.configSchema && typeof schema.configSchema === 'object'
        ? schema.configSchema as Record<string, { required?: boolean; secret?: boolean; env?: string }>
        : {};
      const optionValues = option && typeof option === 'object' && !Array.isArray(option)
        ? option as Record<string, unknown>
        : {};
      const credentialOptions = Object.entries(configSchema).filter(([, field]) => field.required && field.secret && field.env);
      const missingCredentials = credentialOptions
        .filter(([key, field]) => {
          const value = optionValues[key];
          return !(typeof value === 'string' && value.length > 0 && !isEnvReference(value)) && !(ctx.runtime.env(field.env ?? '') || '').length;
        })
        .map(([, field]) => field.env as string);
      const baseDir = slot === 'storage' && option && typeof option === 'object' &&
        'baseDir' in option && typeof option.baseDir === 'string'
        ? resolvePlatformDataPath(option.baseDir, { dataRoot: platformDataRoot }, `platform.adapterOptions.${configKey}.baseDir`)
        : undefined;
      const localLogsAvailable = slot === 'logs' &&
        Boolean(effectiveAdapters.logRingBuffer || effectiveAdapters.logPersistence);
      const hostStatus = hostStatuses.get(slot);
      const slotRuntimeKnown = runtimeStatus === 'known' && hostStatus !== undefined;
      const unconfigured = ADAPTER_DEFAULTS[slot].defaultFallback === 'noop' && !packageId &&
        (runtimeStatus === 'known' && !hostStatus ||
          slotRuntimeKnown && hostStatus.mode === 'noop' && !hostStatus.configuredPackage);
      const implementation = unconfigured ? null : projectEffectiveAdapterImplementation(
        slot,
        effectiveAdapters,
        slotRuntimeKnown ? hostStatus.implementation : undefined,
        localLogsAvailable ? 'HybridLogReader' : undefined,
      );
      return {
        slot,
        implementation,
        mode: unconfigured ? 'unconfigured' : slotRuntimeKnown ? hostStatus.mode : 'unknown',
        runtimeStatus: slotRuntimeKnown ? 'known' : 'unknown',
        ...(!slotRuntimeKnown ? { runtimeReason: runtimeStatus === 'known' ? `Host did not report slot ${slot}.` : runtimeReason } : {}),
        ...(hostStatus?.reason === 'load-failed' ? { reason: hostStatus.reason } : {}),
        ...(hostStatus?.correlationId ? { correlationId: hostStatus.correlationId } : {}),
        ...(hostStatus?.action ? { action: hostStatus.action } : {}),
        ...(!slotRuntimeKnown ? { action: { id: 'start-host', label: 'Start host', command: startHostCommand } } : {}),
        ...(baseDir ? { baseDir } : {}),
        networkRequired: projectNetworkRequirement(schema),
        ...(ADAPTER_DEFAULTS[slot].defaultFallback === 'noop' && !packageId ? { requiresConfiguration: true } : {}),
        ...(credentialOptions.length > 0 ? {
          credentialsStatus: missingCredentials.length > 0 ? 'missing' : 'configured',
          ...(missingCredentials.length > 0 ? { missingCredentials } : {}),
        } : {}),
      };
    });
    const knownSlots = new Set(rows.map((row) => row.slot));
    for (const [slot, configured] of Object.entries(effectiveAdapters)) {
      if (knownSlots.has(slot)) {continue;}
      const configuredPackage = typeof configured === 'string' ? configured : Array.isArray(configured) ? configured[0] : undefined;
      if (!configuredPackage) {continue;}
      const implementation = adapterPackageName(configuredPackage);
      const schema = discovered.get(adapterPackageRoot(implementation))?.module.manifest;
      rows.push({ slot, implementation, mode: 'unknown', runtimeStatus: 'unknown', runtimeReason,
        action: { id: 'start-host', label: 'Start host', command: startHostCommand },
        networkRequired: projectNetworkRequirement(schema) });
    }
    return {  adapters: rows, projectRoot: loaded.projectRoot };
  },
  formatter(result, ctx, flags) {
    ctx.ui?.table?.(result.adapters ?? []);
  },
});
