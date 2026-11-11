import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { registryPost } from '../registry-http.js';

interface ShareFlags {
  with?: string;
  link?: boolean;
  ttl?: string;
  json?: boolean;
}

interface ShareTokenResult {
  token?: string;
  pkg?: string;
  expiresAt?: string;
  added?: string;
}

export default defineCommand<unknown, CLIInput<ShareFlags>, ShareTokenResult | undefined>({
  id: 'marketplace:share',
  description: 'Share a private plugin (--with or --link)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ShareFlags>): Promise<CommandResult<ShareTokenResult | undefined>> {
      const { flags = {}, argv = [] } = input;
      const pkg = argv[0];
      const t0 = Date.now();

      if (!pkg) {
        return validationError('Package spec is required', 'Usage: kb hub access add kb:handle/name [--with handle | --link]');
      }

      if (!flags.with && !flags.link) {
        return validationError('Specify --with <handle> to grant access, or --link to generate a share token');
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
        if (flags.with) {
          await registryPost(`/packages/${handle}/${encodeURIComponent(name)}/share/allowlist`, { namespaceId: flags.with });

          if (flags.json) {
            return { added: flags.with, pkg };
          }

          ctx.ui?.success?.(`${flags.with} can now install ${pkg}`, {
            sections: [
              {
                header: 'Install command for them',
                items: [{ text: `kb marketplace install ${pkg}`, truncate: 500 }],
              },
            ],
            hint: 'For one-time access without an account, use --link instead',
            timing: Date.now() - t0,
          });
          return;
        }

        const ttlDays = flags.ttl ? parseInt(flags.ttl, 10) : 7;
        const result = await registryPost<ShareTokenResult>(`/packages/${handle}/${encodeURIComponent(name)}/share/token`, { ttlDays });

        if (flags.json) {
          return result;
        }

        const expiry = result.expiresAt
          ? new Date(result.expiresAt).toLocaleDateString()
          : `${ttlDays} days`;

        ctx.ui?.success?.('Share link created', {
          summary: {
            'Token':   result.token ?? '–',
            'Expires': expiry,
            'Package': pkg,
          },
          sections: [{
            header: 'Send this command to share',
            items: [{ text: `kb marketplace install ${pkg} --token ${result.token}`, truncate: 500 }],
          }],
          timing: Date.now() - t0,
        });

        return result;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
