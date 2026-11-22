import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';

export type ManagedPlatformMutationRequest =
  | { operation: "install"; specs: string[]; dev?: boolean; shareToken?: string }
  | { operation: "update"; packageIds?: string[] };

export class ManagedPlatformOwnerError extends Error {
  readonly code = 'KB_MARKETPLACE_INSTALL_FAILED';
  constructor(message = 'The managed installation owner could not complete the Marketplace request.') {
    super(message);
    this.name = 'ManagedPlatformOwnerError';
  }
}

/** Conservatively identify the version-root layout used by managed installs. */
export async function isManagedPlatformRoot(platformRoot: string): Promise<boolean> {
  try {
    const physicalRoot = await realpath(platformRoot);
    const versions = path.dirname(physicalRoot);
    return path.basename(versions) === 'versions';
  } catch {
    return false;
  }
}

/**
 * Build the server-side dispatcher used after Marketplace API authorization.
 * Its executable and generation roots come from Go's managed Host startup,
 * never from request data or PATH lookup.
 */
export function createManagedPlatformMutationDispatcher(options: {
  ownerBinary: string | undefined;
  platformRoot: string;
}): (request: ManagedPlatformMutationRequest) => Promise<unknown> {
  return async (request) => {
    if (request.operation === "install" && request.shareToken) throw new ManagedPlatformOwnerError('Managed platform installation does not accept request-scoped share tokens.');
    if (!options.ownerBinary || !path.isAbsolute(options.ownerBinary)) {
      throw new ManagedPlatformOwnerError('The trusted managed Marketplace owner executable is not configured.');
    }
    const [binaryPath, binaryInfo] = await Promise.all([realpath(options.ownerBinary), lstat(options.ownerBinary)]);
    if (binaryPath !== options.ownerBinary || !binaryInfo.isFile() || binaryInfo.isSymbolicLink()) {
      throw new ManagedPlatformOwnerError('The trusted managed Marketplace owner executable is not a physical file.');
    }
    if (!path.isAbsolute(options.platformRoot)) {
      throw new ManagedPlatformOwnerError('The managed Marketplace installation root is invalid.');
    }

    const child = spawn(binaryPath, [
      'marketplace-owner',
      '--platform-root', options.platformRoot,
      '--json',
    ], {
      cwd: options.platformRoot,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputSize = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 64 * 1024) child.kill('SIGKILL');
      else output.push(chunk);
    });
    const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code }));
    });
    const mutation = request.operation === 'install'
      ? { operation: 'install', specs: request.specs, ...(request.dev === undefined ? {} : { dev: request.dev }) }
      : { operation: 'update', ...(request.packageIds === undefined ? {} : { packageIds: request.packageIds }) };
    child.stdin.end(JSON.stringify({ mutation }));
    const result = await completion;
    if (result.error || result.code !== 0 || outputSize > 64 * 1024) {
      throw new ManagedPlatformOwnerError();
    }
    try {
      return JSON.parse(Buffer.concat(output).toString('utf8')) as unknown;
    } catch {
      throw new ManagedPlatformOwnerError('The managed installation owner returned an invalid response.');
    }
  };
}
