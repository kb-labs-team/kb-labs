/**
 * Tests for bootstrap-cli-credentials (#271).
 *
 * On non-local ("--yes") installs, the gateway mints a fixed-handle machine
 * service account on first start and writes ~/.kb/credentials.json so the
 * CLI works without a manual `kb auth login`.
 *
 * Invariants:
 * - No-op when disabled.
 * - No-op when the credentials file already exists (idempotent).
 * - Writes a valid, chmod-0600 credentials file on first run.
 * - When the reserved handle is already registered but the file is missing,
 *   logs a warning and does not throw or write a broken file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CredentialsManager } from '../../../../../sdk/sdk/src/gateway/credentials.js';
import { SessionManager } from '../../../../../sdk/sdk/src/gateway/session.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuthService } from '../service.js';
import { ensureBootstrapCliCredentials, CLI_BOOTSTRAP_HANDLE } from '../bootstrap-cli-credentials.js';

const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!!' };

function createMemCache() {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set<T>(key: string, value: T, _ttl?: number): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}

let cache: ReturnType<typeof createMemCache>;
let authService: AuthService;
let tmpDir: string;
let credentialsPath: string;
let warnings: unknown[];
let infos: unknown[];

const logger = {
  warn: (...args: unknown[]) => warnings.push(args),
  info: (...args: unknown[]) => infos.push(args),
  error: () => undefined,
};

beforeEach(async () => {
  cache = createMemCache();
  authService = new AuthService(cache as any, jwtConfig);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-bootstrap-cli-'));
  credentialsPath = path.join(tmpDir, 'credentials.json');
  warnings = [];
  infos = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('disabled', () => {
  it('is a no-op when not enabled', async () => {
    await ensureBootstrapCliCredentials({
      enabled: false,
      authService,
      gatewayUrl: 'http://127.0.0.1:4000',
      credentialsPath,
      logger,
    });
    await expect(fs.access(credentialsPath)).rejects.toThrow();
  });
});

describe('happy path', () => {
  it('writes a valid, chmod-0600 credentials file on first run', async () => {
    await ensureBootstrapCliCredentials({
      enabled: true,
      authService,
      gatewayUrl: 'http://127.0.0.1:4000',
      credentialsPath,
      logger,
    });

    const raw = await fs.readFile(credentialsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.gatewayUrl).toBe('http://127.0.0.1:4000');
    expect(typeof parsed.accessToken).toBe('string');
    expect(typeof parsed.refreshToken).toBe('string');
    expect(typeof parsed.expiresAt).toBe('number');
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());

    const stat = await fs.stat(credentialsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('registers the client under the reserved cli-bootstrap handle', async () => {
    await ensureBootstrapCliCredentials({
      enabled: true,
      authService,
      gatewayUrl: 'http://127.0.0.1:4000',
      credentialsPath,
      logger,
    });
    // A second, direct register() with the same handle must now conflict.
    await expect(
      authService.register({ name: 'Another', handle: CLI_BOOTSTRAP_HANDLE, capabilities: [] }),
    ).rejects.toMatchObject({ code: 'HANDLE_TAKEN' });
  });
});

describe('idempotency', () => {
  it('does nothing on a second run once the file exists', async () => {
    await ensureBootstrapCliCredentials({
      enabled: true,
      authService,
      gatewayUrl: 'http://127.0.0.1:4000',
      credentialsPath,
      logger,
    });
    const firstContent = await fs.readFile(credentialsPath, 'utf-8');

    await ensureBootstrapCliCredentials({
      enabled: true,
      authService,
      gatewayUrl: 'http://127.0.0.1:4000',
      credentialsPath,
      logger,
    });
    const secondContent = await fs.readFile(credentialsPath, 'utf-8');
    expect(secondContent).toBe(firstContent);
  });
});

describe('handle already registered, file missing', () => {
  it('logs a warning and does not throw or write a file', async () => {
    // Simulate a previous successful run whose credentials file was later deleted.
    await authService.register({ name: 'CLI Bootstrap', handle: CLI_BOOTSTRAP_HANDLE, capabilities: [] });

    await ensureBootstrapCliCredentials({
      enabled: true,
      authService,
      gatewayUrl: 'http://127.0.0.1:4000',
      credentialsPath,
      logger,
    });

    expect(warnings.length).toBeGreaterThan(0);
    await expect(fs.access(credentialsPath)).rejects.toThrow();
  });
});

// case: S-285.19
it('shares bootstrap credentials and session under KB_HOME without touching HOME', async () => {
  const home = path.join(tmpDir, 'home');
  const kbHome = path.join(tmpDir, 'kb-home');
  await fs.mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('KB_HOME', kbHome);
  try {
    await ensureBootstrapCliCredentials({ enabled: true, authService, gatewayUrl: 'http://127.0.0.1:4000', logger });
    const credentials = await new CredentialsManager().load();
    expect(credentials?.gatewayUrl).toBe('http://127.0.0.1:4000');
    const session = new SessionManager();
    await session.save({ gatewayUrl: 'http://127.0.0.1:4000', accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 10000 });
    expect(await session.load()).not.toBeNull();
    await expect(fs.access(path.join(kbHome, 'credentials.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(kbHome, 'session.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(home, '.kb'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { vi.unstubAllEnvs(); }
});
