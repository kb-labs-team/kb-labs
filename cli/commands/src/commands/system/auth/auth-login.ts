/**
 * kb auth login — Authenticate CLI with Gateway.
 *
 * Two identities, one command:
 * - `--client-id`/`--client-secret` (machine): exchanges credentials for a
 *   JWT pair via POST /auth/token, saves to ~/.kb/credentials.json.
 * - `--email`/`--password` (human): exchanges credentials for a JWT pair via
 *   POST /auth/login/cli (the CLI-only, no-cookies analogue of the browser
 *   /auth/login — see services/gateway/app/src/auth/user-routes.ts), saves
 *   to ~/.kb/session.json via SessionManager. This is what lets admin-gated
 *   actions like "kb auth register" work from the CLI at all — a machine
 *   token alone can never carry MACHINE_REGISTER (see auth-register.ts).
 *
 * Both branches auto-refresh on expiry and chmod their store 0o600.
 */

import { defineSystemCommand, throwSystemCataloguedError, throwSystemCommandError, type CommandResult } from '@kb-labs/shared-command-kit';
import { AuthSessionOwner } from '@kb-labs/sdk/gateway';
import { toErrorEnvelope } from '@kb-labs/core-platform';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { promptForPassword, readPasswordFromStdin } from './password-input.js';

type LoginFlags = {
  'gateway-url': { type: 'string'; description: string };
  'client-id': { type: 'string'; description: string };
  'client-secret': { type: 'string'; secret: true; description: string };
  email: { type: 'string'; description: string };
  password: { type: 'string'; secret: true; description: string };
  'password-stdin': { type: 'boolean'; description: string };
  json: { type: 'boolean'; description: string };
};

type LoginResult = CommandResult & {
  gatewayUrl: string;
  expiresIn: number;
  handle?: string;
  email?: string;
  tenantId?: string;
};

export const authLogin = defineSystemCommand<LoginFlags, LoginResult>({
  name: 'login',
  scope: 'platform',
  authProtection: 'public',
  jsonTest: { noSafeValidPath: "This command creates an authentication session." },
  description: 'Authenticate CLI with Gateway',
  longDescription:
    'Machine identity: exchange --client-id/--client-secret for JWT tokens, saved to ' +
    '~/.kb/credentials.json. Use "kb auth register" to create credentials first. ' +
    'Human identity: exchange --email and a prompted or stdin password for JWT tokens, saved to ' +
    '~/.kb/session.json. Both auto-refresh on expiry.',
  category: 'auth',
  examples: [
    'kb auth login --gateway-url <gateway-url> --client-id clt_xxx --client-secret cs_xxx',
    'kb auth login --gateway-url <gateway-url> --email admin@example.com',
    'kb auth login --gateway-url <gateway-url> --email admin@example.com --password-stdin < password.txt',
    'kb auth login --gateway-url https://gateway.example.com --client-id clt_xxx --client-secret cs_xxx --json',
  ],
  flags: {
    'gateway-url': { type: 'string', description: 'Gateway server URL' },
    'client-id': { type: 'string', description: 'Client ID from service account registration' },
    'client-secret': { type: 'string', secret: true, description: 'Client Secret from service account registration' },
    email: { type: 'string', description: 'Email for human (admin) login' },
    password: { type: 'string', secret: true, description: 'Password for human (admin) login' },
    'password-stdin': { type: 'boolean', description: 'Read the human password from stdin' },
    json: { type: 'boolean', description: 'Output in JSON format' },
  },
  // eslint-disable-next-line sonarjs/cognitive-complexity
  async handler(ctx, _argv, flags) {
    const gatewayUrl = flags['gateway-url'];
    const clientId = flags['client-id'];
    const clientSecret = flags['client-secret'];
    const email = flags.email;

    if (!gatewayUrl) {
      const msg = '--gateway-url is required, plus either --client-id/--client-secret or --email';
      throwSystemCommandError(msg, "Run `kb auth login --help` to review valid inputs and recovery steps, then retry.");
    }

    const passwordStdinCommand = `cat password.txt | kb auth login --gateway-url ${shellQuote(gatewayUrl)} --email ${shellQuote(email ?? '')} --password-stdin`;

    if (flags['password-stdin'] && flags.password) {
      throwSystemCommandError('Choose either --password or --password-stdin.', 'Run `kb auth login --help` and retry with one password source.');
    }

    let password = flags.password;
    if (!password && flags['password-stdin']) {
      password = await readPasswordFromStdin();
    } else if (!password && email) {
      password = await promptForPassword(passwordStdinCommand);
    }

    if (email && !password) {
      throwSystemCommandError(
        'No password was provided for the human login.',
        passwordStdinCommand,
      );
    }

    if (email && password) {
      return humanLogin(ctx, flags, gatewayUrl, email, password);
    }

    if (!clientId || !clientSecret) {
      const msg = 'Provide either --client-id/--client-secret (machine) or --email with a password (human)';
      throwSystemCommandError(msg, "Run `kb auth login --help` to review valid inputs and recovery steps, then retry.");
    }

    const owner = new AuthSessionOwner();
    let credentials: Awaited<ReturnType<AuthSessionOwner['loginMachine']>>;
    try {
      credentials = await owner.loginMachine(gatewayUrl, clientId, clientSecret);
    } catch (error) {
      reportLoginFailure(error);
    }
    const expiresIn = credentials.expiresAt - Date.now();

    if (!flags.json) {
      ctx.ui?.write?.(`Authenticated with Gateway at ${gatewayUrl}\n`);
      if (credentials.handle) { ctx.ui?.write?.(`Handle: ${credentials.handle}\n`); }
      ctx.ui?.write?.(`Token expires in ${Math.floor(expiresIn / 60000)} minutes (auto-refresh enabled).\n`);
    }

    return { gatewayUrl, expiresIn: Math.floor(expiresIn / 1000), ...(credentials.handle ? { handle: credentials.handle } : {}) };
  },
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function reportLoginFailure(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'envelope' in error) {
    throwSystemCataloguedError(toErrorEnvelope(error.envelope));
  }
  throwSystemCommandError('Gateway authentication failed. Check the Gateway URL and credentials, then retry.',
    'Run `kb auth login --help` to review valid inputs and recovery steps, then retry.');
}

/** Human (email/password) login branch — see the module docblock. */
async function humanLogin(
  ctx: PluginContextV3,
  flags: { json?: boolean },
  gatewayUrl: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const owner = new AuthSessionOwner();
  let result: Awaited<ReturnType<AuthSessionOwner['loginSession']>>;
  try {
    result = await owner.loginSession(gatewayUrl, email, password);
  } catch (error) {
    reportLoginFailure(error);
  }
  const profileEmail = result.credential.email;
  const tenantId = result.credential.tenantId;

  if (!flags.json) {
    ctx.ui?.write?.(`Authenticated with Gateway at ${gatewayUrl}\n`);
    if (profileEmail) { ctx.ui?.write?.(`Email: ${profileEmail}\n`); }
    ctx.ui?.write?.(`Token expires in ${Math.floor(result.expiresIn / 60)} minutes (auto-refresh enabled).\n`);
  }

  return {

    gatewayUrl,
    expiresIn: result.expiresIn,
    ...(profileEmail ? { email: profileEmail } : {}),
    ...(tenantId ? { tenantId } : {}),
  };
}
