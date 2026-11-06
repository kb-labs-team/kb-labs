import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PnpmInstaller } from '../pnpm-installer.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function createInstallerFixture(): Promise<{ dir: string; pnpmPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-store-pnpm-'));
  tempDirs.push(dir);
  const pnpmPath = path.join(dir, 'pnpm.mjs');
  await fs.writeFile(pnpmPath, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst project = process.cwd();\nconst manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));\nconst name = Object.keys(manifest.dependencies)[0];\nconst target = path.join(project, 'node_modules', ...name.split('/'));\nfs.mkdirSync(target, { recursive: true });\nfs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));\nfs.writeFileSync(path.join(project, 'observed-spec.txt'), manifest.dependencies[name]);\n`, { mode: 0o755 });
  return { dir, pnpmPath };
}

describe('PnpmInstaller registry tarball integrity', () => {
  it('verifies the registry bytes and preserves their integrity for direct tarball specs', async () => {
    const { dir, pnpmPath } = await createInstallerFixture();
    const tarball = Buffer.from('registry tarball bytes');
    const expectedIntegrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tarball)));
    const projectDir = path.join(dir, 'project');

    const installed = await new PnpmInstaller({ pnpmPath }).install({
      name: '@kb-labs/demo',
      version: '1.2.3',
      spec: 'https://registry.example.test/demo-entry-1.2.3.tgz',
      expectedIntegrity,
      projectDir,
      casDir: path.join(dir, 'store'),
    });

    expect(installed.integrity).toBe(expectedIntegrity);
    expect(await fs.readFile(path.join(projectDir, 'observed-spec.txt'), 'utf8')).toContain('file:');
    const packageRoot = await fs.realpath(installed.packageRoot);
    expect(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).toContain('@kb-labs/demo');
  });

  it('rejects tarball bytes that do not match the registry integrity', async () => {
    const { dir, pnpmPath } = await createInstallerFixture();
    const expectedIntegrity = `sha512-${crypto.createHash('sha512').update('expected').digest('base64')}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('different'))));

    await expect(new PnpmInstaller({ pnpmPath }).install({
      name: '@kb-labs/demo',
      version: '1.2.3',
      spec: 'https://registry.example.test/demo-entry-1.2.3.tgz',
      expectedIntegrity,
      projectDir: path.join(dir, 'project'),
      casDir: path.join(dir, 'store'),
    })).rejects.toMatchObject({ code: 'KB_PLUGIN_INTEGRITY_MISMATCH' });
  });
});
