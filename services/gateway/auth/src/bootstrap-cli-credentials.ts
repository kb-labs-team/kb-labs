/**
 * @module @kb-labs/gateway-auth/bootstrap-cli-credentials
 *
 * First-run CLI credential provisioning (#271).
 *
 * Non-local (`--yes`/server-mode) installs run with auth enabled but seed no
 * machine credential — `kb auth login` needs a client-id/secret nobody has,
 * and `/auth/register` is gated behind MACHINE_REGISTER which requires an
 * already-authenticated admin. `ensureBootstrapCliCredentials` closes that
 * gap by minting a fixed-handle machine service account in-process (no HTTP
 * round-trip, so the MACHINE_REGISTER gate never applies) and writing the
 * resulting JWT pair to disk in the same shape the CLI's own
 * `CredentialsManager` (cli/runtime/src/gateway/credentials.ts) expects.
 *
 * Idempotent: skipped entirely once the credentials file exists. If the file
 * is missing but the reserved handle is already registered (e.g. the file was
 * deleted after a previous successful run), this logs a warning and does
 * nothing further — same conservative "never touch existing state, never
 * guess" stance as ensureBootstrapAdmin.
 *
 * Deliberately does not import cli/runtime (a CLI-layer package) — a server
 * process depending on it would invert the dependency graph. The on-disk
 * shape is duplicated here instead (a few lines).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { credentialsFilePath } from '@kb-labs/core-platform';
import type { AuthService } from './service.js';

/** Reserved handle for the auto-provisioned CLI bootstrap client. */
export const CLI_BOOTSTRAP_HANDLE = 'cli-bootstrap';

export interface BootstrapCliCredentialsLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface EnsureBootstrapCliCredentialsOptions {
  /** Gate — set from config.auth.bootstrap.provisionCliCredentials. */
  enabled: boolean;
  authService: AuthService;
  /** Written into the credentials file so the CLI knows where to talk to. */
  gatewayUrl: string;
  /** Defaults to ~/.kb/credentials.json. Overridable for tests. */
  credentialsPath?: string;
  logger: BootstrapCliCredentialsLogger;
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const ensureBootstrapCliCredentials = async (
  opts: EnsureBootstrapCliCredentialsOptions,
): Promise<void> => {
  const { enabled, authService, gatewayUrl, logger } = opts;
  const credentialsPath = opts.credentialsPath ?? credentialsFilePath();

  if (!enabled) {
    logger.info('bootstrap-cli-credentials: not enabled, skipping');
    return;
  }

  if (await fileExists(credentialsPath)) {
    logger.info('bootstrap-cli-credentials: already provisioned, skipping', { credentialsPath });
    return;
  }

  let registered: Awaited<ReturnType<AuthService['register']>>;
  try {
    registered = await authService.register({
      name: 'CLI Bootstrap',
      handle: CLI_BOOTSTRAP_HANDLE,
      capabilities: [],
    });
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'HANDLE_TAKEN') {
      logger.warn(
        'bootstrap-cli-credentials: reserved handle already registered but credentials file is missing; not auto-recovering (client secret is not retrievable) — run `kb auth register` manually',
        { handle: CLI_BOOTSTRAP_HANDLE },
      );
      return;
    }
    throw err;
  }

  const tokens = await authService.issueTokens(registered.clientId, registered.clientSecret);
  if (!tokens) {
    logger.warn('bootstrap-cli-credentials: token issuance failed right after registration');
    return;
  }

  const credentials = {
    gatewayUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };

  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
  await fs.chmod(credentialsPath, 0o600);

  logger.info('bootstrap-cli-credentials: provisioned CLI bootstrap credential', {
    credentialsPath,
    hostId: registered.hostId,
  });
};
