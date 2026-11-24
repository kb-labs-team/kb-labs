/**
 * kb auth logout — Remove stored Gateway credentials.
 *
 * Revokes Gateway refresh tokens, then clears both local identity stores.
 */

import { defineSystemCommand, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { AuthSessionOwner } from '@kb-labs/sdk/gateway';

type LogoutFlags = {
  'gateway-url': { type: 'string'; description: string };
  json: { type: 'boolean'; description: string };
};

export const authLogout = defineSystemCommand<LogoutFlags, CommandResult>({
  name: 'logout',
  scope: 'platform',
  authProtection: 'public',
  jsonTest: { noSafeValidPath: "This command revokes an authentication session." },
  description: 'Remove stored Gateway credentials',
  longDescription: 'Revokes saved Gateway refresh tokens. Use --gateway-url to sign out from one Gateway; without it, all saved identities are removed.',
  category: 'auth',
  examples: [
    'kb auth logout',
    'kb auth logout --gateway-url https://gateway.example.com',
    'kb auth logout --json',
  ],
  flags: {
    'gateway-url': { type: 'string', description: 'Sign out from this Gateway only' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    let loggedOut: boolean;
    try {
      loggedOut = await new AuthSessionOwner().logout(flags['gateway-url']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway token revocation failed.';
      throwSystemCommandError(message, 'Run `kb auth status` to inspect the session, then retry `kb auth logout`.');
    }
    if (!loggedOut) {
      const message = 'No credentials found — already logged out.';
      if (!flags.json) {
        ctx.ui?.write?.(`${message}\n`);
      }
      return {  message };
    }

    const message = 'Logged out. Credentials removed.';
    if (!flags.json) {
      ctx.ui?.write?.(`${message}\n`);
    }

    return {  message };
  },
});
