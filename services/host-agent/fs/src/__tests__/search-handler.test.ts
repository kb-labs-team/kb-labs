import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SearchHandler } from '../search-handler.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function createTestDir(): string {
  const dir = join(tmpdir(), `kb-search-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SearchHandler', () => {
  let testDir: string;
  let handler: SearchHandler;

  beforeEach(() => {
    testDir = createTestDir();
    handler = new SearchHandler({ allowedPaths: [testDir] });

    // Create test files
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'index.ts'), 'export const hello = "world";\nexport function greet() { return hello; }');
    writeFileSync(join(testDir, 'src', 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }');
    writeFileSync(join(testDir, 'README.md'), '# Test Project\nThis is a test.');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('grep finds matches in files', async () => {
    const result = await handler.handle({
      type: 'call',
      requestId: '1',
      adapter: 'search',
      method: 'grep',
      args: ['hello', testDir, {}],
    }) as { matches: Array<{ file: string; content: string }>; totalMatches: number };

    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.matches.some(m => m.content.includes('hello'))).toBe(true);
  });

  it('grep returns empty for no matches', async () => {
    const result = await handler.handle({
      type: 'call',
      requestId: '2',
      adapter: 'search',
      method: 'grep',
      args: ['nonexistent_string_xyz', testDir, {}],
    }) as { matches: unknown[]; totalMatches: number };

    expect(result.totalMatches).toBe(0);
    expect(result.matches.length).toBe(0);
  });

  it('glob finds files by pattern', async () => {
    const result = await handler.handle({
      type: 'call',
      requestId: '3',
      adapter: 'search',
      method: 'glob',
      args: ['*.ts', testDir, {}],
    }) as { files: string[]; totalFiles: number };

    expect(result.totalFiles).toBeGreaterThan(0);
    expect(result.files.some(f => f.endsWith('.ts'))).toBe(true);
  });

  it('rejects path outside allowedPaths', async () => {
    await expect(
      handler.handle({
        type: 'call',
        requestId: '4',
        adapter: 'search',
        method: 'grep',
        args: ['test', '/etc', {}],
      }),
    ).rejects.toThrow(/access denied/i);
  });

  it('throws on unknown method', async () => {
    await expect(
      handler.handle({
        type: 'call',
        requestId: '5',
        adapter: 'search',
        method: 'unknown',
        args: [],
      }),
    ).rejects.toThrow(/unknown search method/i);
  });
});
