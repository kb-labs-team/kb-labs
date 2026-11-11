/** Bind an installed machine adapter to a platform slot. */

import { configErrorEnvelope, createAdapterOptionsValidator, setUserConfigValue } from '@kb-labs/core-config';
import { configuredAdapterForSlot, loadPlatformConfig, PlatformUserConfigSchema, projectEffectiveAdapterImplementation } from '@kb-labs/core-runtime';
import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { generateExamples } from '../../../utils/generate-examples';
import { requireResolvedCatalog } from '../../../registry/discovery-state.js';
import { resolveConfigRoots, userConfigFileForScope } from '../config/shared';

type Flags = {
  json: { type: 'boolean'; description?: string };
  'dry-run': { type: 'boolean'; description?: string };
};

type BindResult = CommandResult & {
  slot?: string;
  packageId?: string;
  file?: string;
  changed?: boolean;
  dryRun?: boolean;
  effectiveState?: { implementation: string | null };
  hint?: string;
  envelope?: ReturnType<typeof configErrorEnvelope>;
};

export const adapterBind = defineSystemCommand<Flags, BindResult>({
  name: 'bind',
  scope: 'platform',
  jsonTest: { noSafeValidPath: "This command changes the platform adapter binding." },
  description: 'Bind an installed adapter to a platform slot',
  longDescription:
    'Writes the platform config key mapped to the requested adapter slot. The adapter package must first be installed in the platform.',
  category: 'adapter',
  examples: generateExamples('adapter bind', 'kb', [
    { flags: {}, description: 'storage @kb-labs/adapters-fs' },
    { flags: { 'dry-run': true, json: true }, description: 'llm @kb-labs/adapters-openai' },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
    'dry-run': { type: 'boolean', description: 'Validate without writing platform config' },
  },
  analytics: {
    command: 'adapter.bind',
    startEvent: 'ADAPTER_BIND_STARTED',
    finishEvent: 'ADAPTER_BIND_FINISHED',
  },
  async handler(ctx, argv, flags) {
    const [slot, packageId] = argv;
    if (!slot || !/^[a-z][a-zA-Z0-9-]*$/.test(slot) || !packageId) {
      throwSystemCommandError('Provide a valid adapter slot and an installed package ID.', "Run `kb adapter bind --help` to review valid inputs and recovery steps, then retry.");
    }

    let roots: Awaited<ReturnType<typeof resolveConfigRoots>>;
    try {
      roots = await resolveConfigRoots(getContextCwd(ctx), 'platform');
    } catch (error) {
      throwSystemCataloguedError(configErrorEnvelope(error));
    }

    try {
      const catalog = requireResolvedCatalog();
      const loaded = await loadPlatformConfig({ moduleUrl: import.meta.url, startDir: getContextCwd(ctx), loadEnvFile: false, projectScope: 'platform', catalog });
      const currentAdapters = loaded.platformConfig.adapters ?? {};
      const configuredAdapter = configuredAdapterForSlot(slot, currentAdapters);
      if (!configuredAdapter) {
        throw new Error(`Adapter slot ${slot} has no platform config key.`);
      }
      const validate = createAdapterOptionsValidator(['platform', 'adapters', configuredAdapter.key], {
        platformRoot: roots.platformRoot,
      });
      const result = await setUserConfigValue({
        filePath: await userConfigFileForScope(roots, 'platform'),
        path: ['platform', 'adapters', configuredAdapter.key],
        value: packageId,
        schema: PlatformUserConfigSchema,
        validate,
        dryRun: Boolean(flags['dry-run']),
      });
      const adapters = result.dryRun
        ? { ...currentAdapters, [configuredAdapter.key]: packageId }
        : (await loadPlatformConfig({ moduleUrl: import.meta.url, startDir: getContextCwd(ctx), loadEnvFile: false, projectScope: 'platform', catalog: requireResolvedCatalog() })).platformConfig.adapters ?? {};
      return {
        slot,
        packageId,
        effectiveState: {
          implementation: projectEffectiveAdapterImplementation(slot, adapters),
        },
        file: result.filePath,
        changed: result.changed,
        dryRun: result.dryRun,
      };
    } catch (error) {
      const envelope = configErrorEnvelope(error);
      throwSystemCataloguedError(envelope);
    }
  },
  formatter(result, ctx, flags) {
    ctx.ui?.success(result.dryRun ? 'Adapter binding is valid; no config written' : 'Adapter bound to platform', {
      sections: [{ header: 'Adapter', items: [`Slot: ${result.slot}`, `Package: ${result.packageId}`, `Config: ${result.file}`] }],
    });
  },
});
