/**
 * @module cli-core/gateway/credentials
 *
 * Manages Gateway credentials stored in ~/.kb/credentials.json.
 * File permissions: 0o600 (owner read/write only).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GatewayCredentials, ICredentialsManager } from './types.js';
import { isSavedCredentialBase, readSavedAuthFile } from './saved-auth-file.js';

export class CredentialsManager implements ICredentialsManager {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(os.homedir(), '.kb', 'credentials.json');
  }

  async load(): Promise<GatewayCredentials | null> {
    return readSavedAuthFile(this.filePath, '.kb/credentials.json', isGatewayCredentials);
  }

  async save(credentials: GatewayCredentials): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(credentials, null, 2), 'utf-8');
    // chmod 600 — owner read/write only
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // file doesn't exist — ok
    }
  }

}

function isGatewayCredentials(value: unknown): value is GatewayCredentials {
  if (!isSavedCredentialBase(value)) return false;
  const record = value as GatewayCredentials;
  return (record.handle === undefined || typeof record.handle === 'string')
    && (record.namespaceId === undefined || typeof record.namespaceId === 'string');
}
