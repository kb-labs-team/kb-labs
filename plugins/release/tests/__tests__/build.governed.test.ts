import { describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runSafeBuild } from '../../src/core/build';

describe('release build run governed execution', () => {
  it('lets tsup config hooks observe generated artifacts inside the isolated package root', async () => {
    const root = join(tmpdir(), `kb-release-build-test-${randomBytes(4).toString('hex')}`);
    const packagePath = join(root, 'packages', 'fixture');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(root, 'tsconfig.base.json'), '{}');
    await writeFile(join(packagePath, 'tsup.config.ts'), 'export default {}');
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({
      name: 'fixture-manifest',
      scripts: { build: 'tsup' },
      kb: { manifest: './dist/manifest.js' },
    }));

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const shell = {
      async exec(command: string, args: string[] = [], options: { cwd?: string } = {}) {
        calls.push({ command, args, cwd: options.cwd });
        if (!existsSync(join(options.cwd!, '..', '..', 'tsconfig.base.json'))) {
          return { code: 1, stdout: '', stderr: 'relative workspace config was not found', ok: false };
        }
        const outputDir = args.includes('-d') ? args[args.indexOf('-d') + 1]! : join(options.cwd!, 'dist');
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, 'manifest.js'), 'export default {}');
        if (!existsSync(join(options.cwd!, 'dist', 'manifest.js'))) {
          return { code: 1, stdout: '', stderr: 'declared manifest module ./dist/manifest.js was not built', ok: false };
        }
        return { code: 0, stdout: 'built manifest', stderr: '', ok: true };
      },
    };

    try {
      const result = await runSafeBuild(packagePath, 'fixture-manifest', shell);

      expect(result.success).toBe(true);
      expect(existsSync(join(packagePath, 'dist', 'manifest.js'))).toBe(true);
      expect(calls[0]).toMatchObject({ command: 'npx', args: ['tsup'] });
      expect(calls[0]?.cwd).not.toBe(packagePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps stdout diagnostics when a failed build also writes to stderr', async () => {
    const packagePath = join(tmpdir(), `kb-release-build-test-${randomBytes(4).toString('hex')}`);
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'echo ok' } }));

    const shell = {
      async exec() {
        return {
          code: 1,
          stdout: 'ERROR in ./src/main.tsx\nModule not found',
          stderr: 'Warning: optional manifest metadata unavailable',
          ok: false,
        };
      },
    };

    try {
      const result = await runSafeBuild(packagePath, 'fixture', shell);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ERROR in ./src/main.tsx\nModule not found');
      expect(result.error).toContain('Warning: optional manifest metadata unavailable');
    } finally {
      await rm(packagePath, { recursive: true, force: true });
    }
  });

  it('delegates build commands to the injected shell with structured argv', async () => {
    const packagePath = join(tmpdir(), `kb-release-build-test-${randomBytes(4).toString('hex')}`);
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'echo ok' } }));

    const calls: Array<{ command: string; args: string[]; cwd?: string; timeout?: number; env?: Record<string, string> }> = [];
    const shell = {
      async exec(command: string, args: string[] = [], options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}) {
        calls.push({ command, args, cwd: options.cwd, timeout: options.timeout, env: options.env });
        return { code: 0, stdout: 'governed-build', stderr: '', ok: true };
      },
    };

    const result = await runSafeBuild(packagePath, 'fixture', shell);

    expect(result.success).toBe(true);
    expect(calls).toEqual([{
      command: 'pnpm',
      args: ['run', 'build'],
      cwd: packagePath,
      timeout: 300_000,
      // NODE_ENV=production disables Module Federation dts generation in
      // Studio rspack configs — a reproducible source of indefinite
      // native-threadpool hangs under concurrent builds (see build.ts).
      env: { NODE_ENV: 'production' },
    }]);
  });

  it('runs a bare tsup build script through the safe temp-dir/atomic-swap path', async () => {
    const packagePath = join(tmpdir(), `kb-release-build-test-${randomBytes(4).toString('hex')}`);
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'tsup.config.ts'), 'export default {}');
    await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: 'fixture-tsup', scripts: { build: 'tsup' } }));

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const shell = {
      async exec(command: string, args: string[] = [], options: { cwd?: string } = {}) {
        calls.push({ command, args, cwd: options.cwd });
        await mkdir(join(options.cwd!, 'dist'), { recursive: true });
        await writeFile(join(options.cwd!, 'dist', 'index.js'), 'export {}');
        return { code: 0, stdout: 'tsup-build', stderr: '', ok: true };
      },
    };

    const result = await runSafeBuild(packagePath, 'fixture-tsup', shell);

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('npx');
    expect(call.args[0]).toBe('tsup');
    expect(call.args).toEqual(['tsup']);
    expect(call.cwd).not.toBe(packagePath);
    expect(existsSync(join(packagePath, 'dist', 'index.js'))).toBe(true);
  });

  it('does NOT take the bare-tsup fast path for a compound build script (regression: studio-app rspack+tsup build)', async () => {
    // Reproduces the real bug found in the published @kb-labs/studio-app
    // 2.119.0 npm tarball: its dist/ contained only manifest.js (tsup's
    // output) and none of the rspack-built SPA (index.html, JS/CSS bundles).
    // The old runSafeBuild logic ran `npx tsup -d tempDir` for ANY package
    // with a tsup.config.ts, silently skipping the `rspack build` half of
    // "rspack build && tsup src/manifest.ts" — so the installed Studio
    // service started (it has server.js + manifest.js) but served 404s for
    // everything, including its health-check path "/", and never became
    // healthy.
    const packagePath = join(tmpdir(), `kb-release-build-test-${randomBytes(4).toString('hex')}`);
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'tsup.config.ts'), 'export default {}');
    await writeFile(
      join(packagePath, 'package.json'),
      JSON.stringify({ name: 'fixture-studio', scripts: { build: 'rspack build && tsup src/manifest.ts' } }),
    );

    const calls: Array<{ command: string; args: string[] }> = [];
    const shell = {
      async exec(command: string, args: string[] = []) {
        calls.push({ command, args });
        return { code: 0, stdout: 'compound-build', stderr: '', ok: true };
      },
    };

    const result = await runSafeBuild(packagePath, 'fixture-studio', shell);

    expect(result.success).toBe(true);
    // Must run the package's own full build script (pnpm run build), not a
    // bare `npx tsup` that would drop the rspack step.
    expect(calls).toEqual([{ command: 'pnpm', args: ['run', 'build'] }]);
  });
});
