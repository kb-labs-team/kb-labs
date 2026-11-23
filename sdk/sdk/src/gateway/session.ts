/**
 * @module cli-core/gateway/session
 *
 * Manages human-user session credentials stored in ~/.kb/session.json.
 * Separate from CredentialsManager (~/.kb/credentials.json, machine identity)
 * — see the module doc on SessionCredentials in ./types.js for why.
 * File permissions: 0o600 (owner read/write only).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sessionFilePath } from '@kb-labs/core-platform';
import type { SessionCredentials, ISessionManager } from './types.js';
import { isSavedCredentialBase, readSavedAuthFile } from './saved-auth-file.js';
import { credentialMatchesGatewayOrigin } from './auth-origin.js';

type SessionStore = { version: 1; sessions: SessionCredentials[] };

export class SessionManager implements ISessionManager {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? sessionFilePath();
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(gatewayUrl?: string): Promise<SessionCredentials | null> {
    const stored = await this.readStore();
    const matches = stored.sessions.filter((session) => !gatewayUrl || credentialMatchesGatewayOrigin(session.gatewayUrl, gatewayUrl));
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  async list(): Promise<SessionCredentials[]> {
    return (await this.readStore()).sessions;
  }

  async save(session: SessionCredentials): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const store = await this.readStore();
    const sessions = store.sessions.filter((saved) => !credentialMatchesGatewayOrigin(saved.gatewayUrl, session.gatewayUrl));
    sessions.push(session);
    await fs.writeFile(this.filePath, JSON.stringify({ version: 1, sessions }, null, 2), 'utf-8');
    // chmod 600 — owner read/write only
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(gatewayUrl?: string): Promise<void> {
    if (gatewayUrl) {
      const store = await this.readStore();
      const sessions = store.sessions.filter((saved) => !credentialMatchesGatewayOrigin(saved.gatewayUrl, gatewayUrl));
      if (sessions.length === store.sessions.length) { return; }
      if (sessions.length === 0) { return this.removeFile(); }
      await fs.writeFile(this.filePath, JSON.stringify({ version: 1, sessions }, null, 2), 'utf-8');
      await fs.chmod(this.filePath, 0o600);
      return;
    }
    await this.removeFile();
  }

  private async removeFile(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // file doesn't exist — ok
    }
  }

  private async readStore(): Promise<SessionStore> {
    const value = await readSavedAuthFile(this.filePath, '.kb/session.json', isSessionStore);
    if (!value) { return { version: 1, sessions: [] }; }
    // A single credential is the on-disk format used before origin-scoped sessions.
    return isSessionCredentials(value)
      ? { version: 1, sessions: [value] }
      : value;
  }

}

function isSessionCredentials(value: unknown): value is SessionCredentials {
  if (!isSavedCredentialBase(value)) {return false;}
  const record = value as SessionCredentials;
  return (record.email === undefined || typeof record.email === 'string')
    && (record.tenantId === undefined || typeof record.tenantId === 'string');
}

function isSessionStore(value: unknown): value is SessionStore | SessionCredentials {
  if (isSessionCredentials(value)) { return true; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const record = value as Record<string, unknown>;
  return record.version === 1 && Array.isArray(record.sessions) && record.sessions.every(isSessionCredentials);
}
