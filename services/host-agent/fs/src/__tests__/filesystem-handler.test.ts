import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemHandler } from '../filesystem-handler.js';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';
import type { WorkspaceFile } from '../filesystem-handler.js';

function call(method: string, ...args: unknown[]): CapabilityCall {
  return { type: 'call', requestId: 'r1', adapter: 'filesystem', method, args };
}

describe('FilesystemHandler', () => {
  let tmpDir: string;
  let handler: FilesystemHandler;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ha-fs-test-'));
    handler = new FilesystemHandler({ allowedPaths: [tmpDir] });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('readFile', () => {
    it('reads existing file', async () => {
      await writeFile(join(tmpDir, 'hello.txt'), 'hello world', 'utf-8');
      const result = await handler.handle(call('readFile', join(tmpDir, 'hello.txt')));
      expect(result).toBe('hello world');
    });

    it('throws on file outside allowedPaths', async () => {
      await expect(handler.handle(call('readFile', '/etc/passwd'))).rejects.toThrow('Access denied');
    });
  });

  describe('writeFile', () => {
    it('writes file', async () => {
      const path = join(tmpDir, 'out.txt');
      await handler.handle(call('writeFile', path, 'content'));
      const result = await handler.handle(call('readFile', path));
      expect(result).toBe('content');
    });

    it('rejects write outside allowedPaths', async () => {
      await expect(handler.handle(call('writeFile', '/tmp/evil.txt', 'x'))).rejects.toThrow('Access denied');
    });
  });

  describe('listDir', () => {
    it('returns file names in directory', async () => {
      await writeFile(join(tmpDir, 'a.ts'), '');
      await writeFile(join(tmpDir, 'b.ts'), '');
      const result = await handler.handle(call('listDir', tmpDir)) as string[];
      expect(result).toContain('a.ts');
      expect(result).toContain('b.ts');
    });
  });

  describe('stat', () => {
    it('returns stat for existing file', async () => {
      await writeFile(join(tmpDir, 'f.txt'), '12345');
      const s = await handler.handle(call('stat', join(tmpDir, 'f.txt'))) as { size: number; isFile: boolean; isDir: boolean };
      expect(s.isFile).toBe(true);
      expect(s.isDir).toBe(false);
      expect(s.size).toBe(5);
    });

    it('returns stat for directory', async () => {
      const sub = join(tmpDir, 'sub');
      await mkdir(sub);
      const s = await handler.handle(call('stat', sub)) as { isFile: boolean; isDir: boolean };
      expect(s.isDir).toBe(true);
      expect(s.isFile).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await writeFile(join(tmpDir, 'x.txt'), '');
      expect(await handler.handle(call('exists', join(tmpDir, 'x.txt')))).toBe(true);
    });

    it('returns false for missing file', async () => {
      expect(await handler.handle(call('exists', join(tmpDir, 'nope.txt')))).toBe(false);
    });
  });

  describe('unknown method', () => {
    it('throws for unsupported method', async () => {
      await expect(handler.handle(call('deleteFile', tmpDir))).rejects.toThrow('Unknown filesystem method');
    });
  });

  describe('fetchWorkspace', () => {
    it('returns all text files with relative paths', async () => {
      await writeFile(join(tmpDir, 'index.ts'), 'export {}');
      await mkdir(join(tmpDir, 'src'));
      await writeFile(join(tmpDir, 'src', 'app.ts'), 'const x = 1;');

      const result = await handler.handle(call('fetchWorkspace', tmpDir)) as WorkspaceFile[];
      expect(Array.isArray(result)).toBe(true);
      const paths = result.map((f) => f.path);
      expect(paths).toContain('index.ts');
      expect(paths).toContain(join('src', 'app.ts'));
      const indexFile = result.find((f) => f.path === 'index.ts')!;
      expect(indexFile.content).toBe('export {}');
    });

    it('excludes node_modules directory', async () => {
      await mkdir(join(tmpDir, 'node_modules'));
      await writeFile(join(tmpDir, 'node_modules', 'lib.js'), 'module.exports = {}');
      await writeFile(join(tmpDir, 'index.ts'), 'export {}');

      const result = await handler.handle(call('fetchWorkspace', tmpDir)) as WorkspaceFile[];
      const paths = result.map((f) => f.path);
      expect(paths).not.toContain(join('node_modules', 'lib.js'));
      expect(paths).toContain('index.ts');
    });

    it('excludes .git directory', async () => {
      await mkdir(join(tmpDir, '.git'));
      await writeFile(join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main');
      await writeFile(join(tmpDir, 'file.ts'), 'x');

      const result = await handler.handle(call('fetchWorkspace', tmpDir)) as WorkspaceFile[];
      const paths = result.map((f) => f.path);
      expect(paths.some((p) => p.startsWith('.git'))).toBe(false);
    });

    it('excludes dist directory', async () => {
      await mkdir(join(tmpDir, 'dist'));
      await writeFile(join(tmpDir, 'dist', 'index.js'), '// built');
      await writeFile(join(tmpDir, 'src.ts'), 'x');

      const result = await handler.handle(call('fetchWorkspace', tmpDir)) as WorkspaceFile[];
      const paths = result.map((f) => f.path);
      expect(paths.some((p) => p.startsWith('dist'))).toBe(false);
      expect(paths).toContain('src.ts');
    });

    it('returns empty array for empty directory', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'ha-fs-empty-'));
      const emptyHandler = new FilesystemHandler({ allowedPaths: [emptyDir] });
      try {
        const result = await emptyHandler.handle(call('fetchWorkspace', emptyDir)) as WorkspaceFile[];
        expect(result).toEqual([]);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    it('rejects workspace path outside allowedPaths', async () => {
      await expect(handler.handle(call('fetchWorkspace', '/etc'))).rejects.toThrow('Access denied');
    });

    it('recurses into nested subdirectories', async () => {
      await mkdir(join(tmpDir, 'a', 'b'), { recursive: true });
      await writeFile(join(tmpDir, 'a', 'b', 'deep.ts'), 'deep');

      const result = await handler.handle(call('fetchWorkspace', tmpDir)) as WorkspaceFile[];
      const paths = result.map((f) => f.path);
      expect(paths).toContain(join('a', 'b', 'deep.ts'));
    });
  });

  describe('security', () => {
    it('rejects path with prefix bypass (no sep)', async () => {
      // /tmp/ha-fs-test-XYZ2 should not be accessible when allowedPaths = [/tmp/ha-fs-test-XYZ]
      const sibling = tmpDir + '2';
      await expect(handler.handle(call('readFile', join(sibling, 'f.txt')))).rejects.toThrow('Access denied');
    });

    it('rejects empty string arg', async () => {
      await expect(handler.handle(call('readFile', ''))).rejects.toThrow('Expected non-empty string');
    });

    it('rejects non-string arg', async () => {
      await expect(handler.handle(call('readFile', 42))).rejects.toThrow('Expected non-empty string');
    });

    it('rejects path traversal sequence', async () => {
      await expect(handler.handle(call('readFile', join(tmpDir, '..', 'etc', 'passwd')))).rejects.toThrow('Access denied');
    });
  });
});
