/**
 * kb auth logout — Remove stored Gateway credentials.
 *
 * Revokes Gateway refresh tokens, then clears both local identity stores.
 */

import { defineSystemCommand, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { AuthSessionOwner } from '@kb-labs/sdk/gateway';

type LogoutFlags = {
  json: { type: 'boolean'; description: string };
};

export const authLogout = defineSystemCommand<LogoutFlags, CommandResult>({
  name: 'logout',
  scope: 'platform',
  authProtection: 'public',
  jsonTest: { noSafeValidPath: "This command revokes an authentication session." },
  description: 'Remove stored Gateway credentials',
  longDescription: 'Revokes saved Gateway refresh tokens, then deletes ~/.kb/credentials.json and ~/.kb/session.json.',
  category: 'auth',
  examples: [
    'kb auth logout',
    'kb auth logout --json',
  ],
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  async handler(ctx, _argv, flags) {
    let loggedOut: boolean;
    try {
      loggedOut = await new AuthSessionOwner().logout();
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
