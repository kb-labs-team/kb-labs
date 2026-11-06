/**
 * Tests for marketplace sync command.
 *
 * Focuses on autoEnable behaviour driven by NODE_ENV:
 *   - development (or unset) → autoEnable: true by default
 *   - production             → autoEnable: false by default
 *   - explicit --auto-enable flag always wins over NODE_ENV
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock http module before importing the command
vi.mock('../../http.js', () => ({
  post: vi.fn(),
}));

import { post } from '../../http.js';
import syncCommand from '../sync.js';

const mockPost = vi.mocked(post);

const SYNC_RESULT = { added: [], skipped: [], total: 0 };

function makeCtx(cwd: string) {
  return {
    host: 'cli',
    cwd,
    ui: {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      json: vi.fn(),
    },
  };
}

async function writeConfig(dir: string, syncInclude: string[]): Promise<void> {
  const kbDir = path.join(dir, '.kb');
  await fs.mkdir(kbDir, { recursive: true });
  await fs.writeFile(
    path.join(kbDir, 'kb.config.json'),
    JSON.stringify({ marketplace: { sync: { include: syncInclude } } }),
  );
}

describe('marketplace sync — autoEnable behaviour', () => {
  let tmpDir: string;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-sync-test-'));
    await writeConfig(tmpDir, ['plugins/*']);
    mockPost.mockResolvedValue(SYNC_RESULT);
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('sends autoEnable: true when NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    await syncCommand.execute(makeCtx(tmpDir) as any, { flags: {} } as any);
    expect(mockPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ autoEnable: true }));
  });

  it('sends autoEnable: true when NODE_ENV is unset (dev default)', async () => {
    delete process.env.NODE_ENV;
    await syncCommand.execute(makeCtx(tmpDir) as any, { flags: {} } as any);
    expect(mockPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ autoEnable: true }));
  });

  it('sends autoEnable: false when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    await syncCommand.execute(makeCtx(tmpDir) as any, { flags: {} } as any);
    expect(mockPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ autoEnable: false }));
  });

  it('explicit --auto-enable flag overrides NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    await syncCommand.execute(makeCtx(tmpDir) as any, { flags: { 'auto-enable': true } } as any);
    expect(mockPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ autoEnable: true }));
  });

  it('explicit --no-auto-enable flag overrides NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    await syncCommand.execute(makeCtx(tmpDir) as any, { flags: { 'auto-enable': false } } as any);
    expect(mockPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ autoEnable: false }));
  });

  it('passes include patterns from kb.config.json', async () => {
    process.env.NODE_ENV = 'production';
    await syncCommand.execute(makeCtx(tmpDir) as any, { flags: {} } as any);
    expect(mockPost).toHaveBeenCalledWith('/workspace/sync', expect.objectContaining({ include: ['plugins/*'] }));
  });

  it('returns exitCode 1 when no include patterns configured', async () => {
    await writeConfig(tmpDir, []);
    const ctx = makeCtx(tmpDir);
    const result = await syncCommand.execute(ctx as any, { flags: {} } as any);
    expect(result).toHaveProperty('ok', false);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
