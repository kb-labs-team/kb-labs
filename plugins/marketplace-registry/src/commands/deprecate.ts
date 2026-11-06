import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { registryPost } from '../registry-http.js';

interface DeprecateFlags {
  message?: string;
  json?: boolean;
}

export default defineCommand<unknown, CLIInput<DeprecateFlags>, unknown>({
  id: 'marketplace:deprecate',
  description: 'Deprecate a package (removed from catalog, install shows warning)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<DeprecateFlags>): Promise<CommandResult> {
      const { flags = {}, argv = [] } = input;
      const pkg = argv[0];
      const t0 = Date.now();

      if (!pkg) {
        return validationError('Package spec is required', 'Usage: kb hub disable kb:handle/name [--message "reason"]');
      }

      if (!pkg.startsWith('kb:')) {
        return validationError('Package must be a kb: spec', 'Example: kb:kirill/my-plugin');
      }

      const sliced = pkg.slice(3);
      const slashIdx = sliced.indexOf('/');
      const handle = slashIdx > 0 ? sliced.slice(0, slashIdx) : '';
      const name = slashIdx > 0 ? sliced.slice(slashIdx + 1) : '';
      if (!handle || !name) {
        return validationError('Invalid kb: spec — expected kb:handle/name');
      }

      try {
        await registryPost(`/packages/${handle}/${encodeURIComponent(name)}/deprecate`, { message: flags.message });

        if (flags.json) {
          return { deprecated: true, pkg };
        }

        const items = [
          'Hidden from the marketplace catalog',
          'Existing installations still work but show a deprecation warning',
          'New installs are allowed but show a warning',
        ];
        if (flags.message) {
          items.push(`Message: ${flags.message}`);
        }

        ctx.ui?.success?.(`${pkg} deprecated`, {
          sections: [{ header: 'What this means', items }],
          hint: 'To block a specific version only, use kb hub version remove instead',
          timing: Date.now() - t0,
        });

        return;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
