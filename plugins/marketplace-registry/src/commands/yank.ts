import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { registryPost } from '../registry-http.js';

interface YankFlags {
  reason?: string;
  json?: boolean;
}

export default defineCommand<unknown, CLIInput<YankFlags>, unknown>({
  id: 'marketplace:yank',
  description: 'Yank a specific version (soft-remove — tarball stays, fresh installs blocked)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<YankFlags>): Promise<CommandResult> {
      const { flags = {}, argv = [] } = input;
      const [pkg, version] = argv;
      const t0 = Date.now();

      if (!pkg || !version) {
        return validationError('Package spec and version are required', 'Usage: kb hub version remove kb:handle/name <version>');
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
        await registryPost(`/packages/${handle}/${encodeURIComponent(name)}/${version}/yank`, { reason: flags.reason });

        if (flags.json) {
          return { yanked: true, pkg, version };
        }

        const items = [
          'Fresh installs of this version are blocked',
          'Existing installations continue to work',
        ];
        if (flags.reason) {
          items.push(`Reason: ${flags.reason}`);
        }

        ctx.ui?.success?.(`${pkg}@${version} yanked`, {
          sections: [{ header: 'What this means', items }],
          hint: 'To yank all versions, deprecate the package instead',
          timing: Date.now() - t0,
        });

        return;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
