import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ configs: [] as NodeJS.ProcessEnv[] }));
vi.mock('@kb-labs/sdk', () => ({
  useLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  useEnv: (name: string) => process.env[name],
}));
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  return { ...real, spawn: (_command: string, args: string[], options: Parameters<typeof real.spawn>[2]) => {
    const env = options?.env ?? {};
    state.configs.push(env);
    const registry = args.find(arg => arg.startsWith('--registry='));
    return real.spawn('npm', ['ping', registry!], options);
  }};
});
import { publishPackagesProgrammatic } from '../../src/shared/publish-programmatic';

describe('registry auth with isolated HOME', () => {
  it.each(['tarball', 'package'] as const)('sends the token from %s publication', async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'x258-auth-'));
    const home = join(root, 'home'); const dir = join(root, 'workspace', 'npm');
    mkdirSync(home, { recursive: true }); mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, '.npmrc'), '');
    if (kind === 'package') writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@kb-labs/fixture', version: '1.0.0' }));
    let authorization = '';
    const server = createServer((req, res) => {
      authorization = req.headers.authorization ?? '';
      res.writeHead(authorization === 'Bearer x258-token' ? 200 : 401, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture port');
    const registry = `http://127.0.0.1:${address.port}`;
    if (kind === 'package') writeFileSync(join(dir, '.npmrc'), `//127.0.0.1:${address.port}/:_authToken=wrong-token\n`);
    const previous = { ...process.env };
    process.env.HOME = home;
    process.env.npm_config_userconfig = join(home, '.npmrc');
    process.env.npm_config_cache = join(root, 'cache');
    delete process.env.NPM_CONFIG_USERCONFIG;
    state.configs.length = 0;
    try {
      const result = await publishPackagesProgrammatic({
        packages: [{ name: '@kb-labs/fixture', version: '1.0.0', path: dir, ...(kind === 'tarball' ? { tarballPath: join(dir, 'fixture.tgz') } : {}) }],
        packageManager: 'npm', registry, token: 'x258-token',
      });
      expect(authorization).toBe('Bearer x258-token');
      expect(result.failed).toEqual([]);
      expect(state.configs[0]?.[`npm_config_//127.0.0.1:${address.port}/:_authToken`]).toBe('x258-token');
      expect(existsSync(join(dir, '.npmrc'))).toBe(kind === 'package');
      if (kind === 'package') expect(readFileSync(join(dir, '.npmrc'), 'utf8')).not.toContain('x258-token');
      expect(readFileSync(join(home, '.npmrc'), 'utf8')).toBe('');
    } finally {
      process.env = previous;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
