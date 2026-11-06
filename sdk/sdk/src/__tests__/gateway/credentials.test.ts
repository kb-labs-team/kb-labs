import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialsManager } from '../../gateway/credentials.js';
import type { GatewayCredentials } from '../../gateway/types.js';

const CREDENTIALS: GatewayCredentials = {
  gatewayUrl: 'http://localhost:4000',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
};

let tmpDir: string;
let filePath: string;
let manager: CredentialsManager;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

async function setup(): Promise<void> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-credentials-test-'));
  filePath = path.join(tmpDir, 'credentials.json');
  manager = new CredentialsManager(filePath);
}

describe('CredentialsManager.load', () => {
  it('returns null only when the file is absent', async () => {
    await setup();
    await expect(manager.load()).resolves.toBeNull();
  });

  it('round-trips valid credentials', async () => {
    await setup();
    await manager.save(CREDENTIALS);
    await expect(manager.load()).resolves.toEqual(CREDENTIALS);
  });

  it('classifies malformed JSON and invalid schema', async () => {
    await setup();
    await fs.writeFile(filePath, '{bad json');
    await expect(manager.load()).rejects.toMatchObject({ name: 'SavedAuthFileError', reason: 'invalid' });
    await fs.writeFile(filePath, JSON.stringify({ gatewayUrl: 'http://localhost:4000' }));
    await expect(manager.load()).rejects.toMatchObject({ name: 'SavedAuthFileError', reason: 'invalid' });
    await fs.writeFile(filePath, JSON.stringify({ ...CREDENTIALS, refreshToken: '' }));
    await expect(manager.load()).rejects.toMatchObject({ name: 'SavedAuthFileError', reason: 'invalid' });
  });

  it('classifies an unreadable path separately from an absent file', async () => {
    await setup();
    const blocker = path.join(tmpDir, 'not-a-directory');
    await fs.writeFile(blocker, 'file');
    manager = new CredentialsManager(path.join(blocker, 'credentials.json'));
    await expect(manager.load()).rejects.toMatchObject({ name: 'SavedAuthFileError', reason: 'unreadable' });
  });
});
