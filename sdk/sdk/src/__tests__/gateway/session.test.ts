/**
 * @module cli-core/__tests__/session
 *
 * Unit tests for SessionManager (~/.kb/session.json — human-user identity,
 * separate from CredentialsManager's machine-identity store).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, sessionFilePath } from '../../gateway/session.js';
import type { SessionCredentials } from '../../gateway/types.js';

const SESSION: SessionCredentials = {
  gatewayUrl: 'http://localhost:4000',
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  expiresAt: Date.now() + 60_000,
  email: 'admin@bootstrap.local',
  tenantId: 'default',
};

let tmpDir: string;
let filePath: string;
let manager: SessionManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-session-test-'));
  filePath = path.join(tmpDir, 'session.json');
  manager = new SessionManager(filePath);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  // case: S-041.6
  it('resolves the canonical human session path from the CLI home directory', () => {
    expect(sessionFilePath('/home/member')).toBe('/home/member/.kb/session.json');
  });

  it('SM-01: load() returns null when no file exists', async () => {
    expect(await manager.load()).toBeNull();
  });

  it('SM-08: load() classifies malformed JSON instead of treating it as a missing session', async () => {
    await fs.writeFile(filePath, '{bad json');
    const error = await manager.load().catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      name: 'SavedAuthFileError', reason: 'invalid', filePath: '.kb/session.json',
      envelope: {
        code: 'KB_CONFIG_INVALID',
        message: 'Saved authentication file .kb/session.json is invalid.',
        hint: 'Run "kb auth login" to replace the saved authentication data, then retry the command.',
        details: { path: '.kb/session.json' },
      },
    });
  });

  it('SM-09: load() rejects a session with missing required fields', async () => {
    await fs.writeFile(filePath, JSON.stringify({ gatewayUrl: 'http://localhost:4000' }));
    await expect(manager.load()).rejects.toMatchObject({ name: 'SavedAuthFileError', reason: 'invalid' });
    await fs.writeFile(filePath, JSON.stringify({ ...SESSION, accessToken: '' }));
    await expect(manager.load()).rejects.toMatchObject({ name: 'SavedAuthFileError', reason: 'invalid' });
  });

  it('SM-10: load() classifies unreadable paths rather than treating them as missing', async () => {
    const blocker = path.join(tmpDir, 'not-a-directory');
    await fs.writeFile(blocker, 'file');
    manager = new SessionManager(path.join(blocker, 'session.json'));
    await expect(manager.load()).rejects.toMatchObject({
      name: 'SavedAuthFileError', reason: 'unreadable', filePath: '.kb/session.json',
    });
  });

  it('SM-02: save() then load() round-trips the session', async () => {
    await manager.save(SESSION);
    expect(await manager.load()).toEqual(SESSION);
  });

  it('SM-03: save() sets file permissions to 0o600', async () => {
    await manager.save(SESSION);
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('SM-04: clear() removes the file; is a no-op when absent', async () => {
    await manager.save(SESSION);
    await manager.clear();
    expect(await manager.load()).toBeNull();
    await expect(manager.clear()).resolves.not.toThrow();
  });

});
