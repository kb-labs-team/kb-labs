import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionStore } from '../store.js';
import { PnpmInstaller } from '../pnpm-installer.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) { reject(error); }
      else { resolve(); }
    });
  })));
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('local registry did not bind'); }
  servers.push(server);
  return `http://127.0.0.1:${address.port}`;
}

async function packPackage(root: string, name: string, version: string, extra: Record<string, unknown> = {}): Promise<Buffer> {
  const packageDir = path.join(root, 'package');
  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name, version, ...extra }));
  await fs.writeFile(path.join(packageDir, 'index.js'), 'module.exports = {}\n');
  const archive = path.join(root, `${name.replaceAll('/', '-')}-${version}.tgz`);
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  return fs.readFile(archive);
}

async function createInstallerFixture(): Promise<{ dir: string; pnpmPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-store-pnpm-'));
  tempDirs.push(dir);
  const pnpmPath = path.join(dir, 'pnpm.mjs');
  await fs.writeFile(pnpmPath, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst project = process.cwd();\nconst manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));\nconst name = Object.keys(manifest.dependencies)[0];\nconst target = path.join(project, 'node_modules', ...name.split('/'));\nfs.mkdirSync(target, { recursive: true });\nfs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));\nfs.writeFileSync(path.join(project, 'observed-spec.txt'), manifest.dependencies[name]);\nfs.writeFileSync(path.join(project, 'observed-args.txt'), process.argv.slice(2).join(' '));\nfs.writeFileSync(path.join(project, 'observed-args.json'), JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(path.join(project, 'observed-corepack-home.txt'), process.env.COREPACK_HOME ?? '');\nfs.writeFileSync(path.join(project, 'observed-package-manager.txt'), manifest.packageManager ?? '');\n`, { mode: 0o755 });
  return { dir, pnpmPath };
}

// case: S-298.1
it('uses the release-pinned Corepack pnpm when no standalone pnpm is on PATH', async () => {
  const { dir, pnpmPath: fakeCorepackPath } = await createInstallerFixture();
  vi.stubEnv('PATH', dir);
  const projectDir = path.join(dir, 'project');
  const casDir = path.join(dir, 'store', 'cas');
  const installer = new PnpmInstaller({
    corepackPath: fakeCorepackPath,
  });

  const installed = await installer.install({
    name: '@kb-labs/demo',
    version: '1.2.3',
    projectDir,
    casDir,
  });

  expect(await fs.realpath(installed.packageRoot)).toContain('@kb-labs/demo');
  await expect(fs.readFile(path.join(projectDir, 'observed-args.txt'), 'utf8')).resolves.toBe('pnpm install --store-dir ' + casDir);
  await expect(fs.readFile(path.join(projectDir, 'observed-corepack-home.txt'), 'utf8')).resolves.toBe(path.join(casDir, '.corepack'));
  await expect(fs.readFile(path.join(projectDir, 'observed-package-manager.txt'), 'utf8')).resolves.toBe('pnpm@11.4.0');
});

// case: S-300.1
it('keeps platform and user pnpm config layers in the Corepack fallback and removes the temporary link', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-store-corepack-config-'));
  tempDirs.push(dir);
  const corepackPath = path.join(dir, 'corepack.mjs');
  await fs.writeFile(corepackPath, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst project=process.cwd();\nconst pkg=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8'));\nconst name=Object.keys(pkg.dependencies)[0];\nconst target=path.join(project,'node_modules',...name.split('/'));\nfs.mkdirSync(target,{recursive:true});\nfs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name,version:'1.2.3'}));\nfs.writeFileSync(path.join(project,'observed-config.txt'),JSON.stringify({link:fs.lstatSync(path.join(project,'.npmrc')).isSymbolicLink(),userconfig:process.env.npm_config_userconfig}));\n`, { mode: 0o755 });
  const platformRoot = path.join(dir, 'platform');
  await fs.mkdir(platformRoot);
  await fs.writeFile(path.join(platformRoot, '.npmrc'), '@fixture:registry=https://registry.invalid\n');
  const userConfigPath = path.join(dir, 'user.npmrc');
  vi.stubEnv('PATH', dir);
  vi.stubEnv('npm_config_userconfig', userConfigPath);
  const projectDir = path.join(dir, 'project');

  await new PnpmInstaller({ corepackPath }).install({
    name: '@kb-labs/demo',
    version: '1.2.3',
    projectDir,
    casDir: path.join(dir, 'store', 'cas'),
    platformRoot,
    usePlatformNpmrc: true,
  });

  await expect(fs.readFile(path.join(projectDir, 'observed-config.txt'), 'utf8')).resolves.toBe(JSON.stringify({ link: true, userconfig: userConfigPath }));
  await expect(fs.lstat(path.join(projectDir, '.npmrc'))).rejects.toThrow();
});

describe('PnpmInstaller registry tarball integrity', () => {
  it('verifies the registry bytes and preserves their integrity for direct tarball specs', async () => {
    const { dir, pnpmPath } = await createInstallerFixture();
    const packageDir = path.join(dir, 'package');
    await fs.mkdir(packageDir);
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/demo', version: '1.2.3', peerDependencies: { '@kb-labs/sdk': '^1.2.3' } }));
    const archive = path.join(dir, 'package.tgz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
    const tarball = await fs.readFile(archive);
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

  it('uses scoped artifact headers and refuses redirects for authenticated tarball downloads', async () => {
    const { dir, pnpmPath } = await createInstallerFixture();
    const packageDir = path.join(dir, 'package');
    await fs.mkdir(packageDir);
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/demo', version: '1.2.3' }));
    const archive = path.join(dir, 'package.tgz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
    const tarball = await fs.readFile(archive);
    const expectedIntegrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
    const shareToken = 'kbrt_0123456789abcdef0123456789abcdef';
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(tarball));
    vi.stubGlobal('fetch', fetchMock);
    const projectDir = path.join(dir, 'project');

    await new PnpmInstaller({ pnpmPath }).install({
      name: '@kb-labs/demo',
      version: '1.2.3',
      spec: 'https://registry.example.test/demo-entry-1.2.3.tgz',
      expectedIntegrity,
      artifactHeaders: { 'X-Share-Token': shareToken },
      projectDir,
      casDir: path.join(dir, 'store'),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-Share-Token': shareToken },
      redirect: 'manual',
    });
    expect(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')).not.toContain(shareToken);
    expect(await fs.readFile(path.join(projectDir, 'observed-spec.txt'), 'utf8')).not.toContain(shareToken);
  });

  it('does not follow an authenticated tarball redirect', async () => {
    const { dir, pnpmPath } = await createInstallerFixture();
    const expectedIntegrity = `sha512-${crypto.createHash('sha512').update(Buffer.from('archive')).digest('base64')}`;
    const shareToken = 'kbrt_0123456789abcdef0123456789abcdef';
    const tarballUrl = 'https://registry.example.test/demo-entry-1.2.3.tgz';
    const redirectUrl = 'https://attacker.test/collect';
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { Location: redirectUrl } }));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await new PnpmInstaller({ pnpmPath }).install({
        name: '@kb-labs/demo',
        version: '1.2.3',
        spec: tarballUrl,
        expectedIntegrity,
        artifactHeaders: { 'X-Share-Token': shareToken },
        projectDir: path.join(dir, 'project'),
        casDir: path.join(dir, 'store'),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'KB_PLUGIN_INSTALL_FAILED',
      envelope: {
        code: 'KB_PLUGIN_INSTALL_FAILED',
        message: 'Installing plugin @kb-labs/demo failed.',
        hint: 'Check the network and registry, then retry.',
      },
    });
    const publicError = JSON.stringify((caught as { envelope?: unknown }).envelope);
    expect(publicError).not.toContain(shareToken);
    expect(publicError).not.toContain(redirectUrl);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(tarballUrl);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-Share-Token': shareToken },
      redirect: 'manual',
    });
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

  // case: S-300.1
  it('uses the installed platform npmrc for transitive registry routing without copying it into the synthetic project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-store-two-registries-'));
    tempDirs.push(dir);
    const sourceRequests: string[] = [];
    const dependencyRequests: string[] = [];
    let dependencyAuthSeen = false;
    let userConfigAuthSeen = false;
    const dependencyTarball = await packPackage(dir, '@fixture/sdk', '1.0.0');
    const dependencyIntegrity = `sha512-${crypto.createHash('sha512').update(dependencyTarball).digest('base64')}`;
    const userConfigTarball = await packPackage(dir, '@other/sdk', '1.0.0');
    const userConfigIntegrity = `sha512-${crypto.createHash('sha512').update(userConfigTarball).digest('base64')}`;
    const dependencyServer = createServer((request, response) => {
      const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
      dependencyRequests.push(requestPath);
      dependencyAuthSeen ||= request.headers.authorization === 'Bearer fixture-token';
      if (request.headers.authorization !== 'Bearer fixture-token') {
        response.writeHead(401).end();
        return;
      }
      if (requestPath.endsWith('/sdk-1.0.0.tgz')) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(dependencyTarball);
        return;
      }
      if (decodeURIComponent(requestPath).includes('@fixture/sdk')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          name: '@fixture/sdk',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: '@fixture/sdk',
              version: '1.0.0',
              dist: { tarball: `${dependencyRegistryUrl}/@fixture/sdk/-/sdk-1.0.0.tgz`, integrity: dependencyIntegrity },
            },
          },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const dependencyRegistryUrl = await listen(dependencyServer);
    const sourceServer = createServer((request, response) => {
      const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      sourceRequests.push(requestPath);
      if (request.url === '/platform-plugin.tgz') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(pluginTarball);
        return;
      }
      if (requestPath.includes('@other/sdk')) {
        const authorized = request.headers.authorization === 'Bearer user-fixture-token';
        userConfigAuthSeen ||= authorized;
        if (!authorized) {
          response.writeHead(401).end();
          return;
        }
        if (requestPath.endsWith('/sdk-1.0.0.tgz')) {
          response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(userConfigTarball);
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          name: '@other/sdk',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: '@other/sdk',
              version: '1.0.0',
              dist: { tarball: `${marketplaceSourceUrl}/@other/sdk/-/sdk-1.0.0.tgz`, integrity: userConfigIntegrity },
            },
          },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const marketplaceSourceUrl = await listen(sourceServer);
    const pluginTarball = await packPackage(dir, '@fixture/platform-plugin', '1.0.0', {
      dependencies: { '@fixture/sdk': '1.0.0', '@other/sdk': '1.0.0' },
    });
    const platformRoot = path.join(dir, 'platform');
    await fs.mkdir(platformRoot);
    const dependencyRegistryHost = new URL(dependencyRegistryUrl).host;
    await fs.writeFile(path.join(platformRoot, '.npmrc'), `@fixture:registry=${dependencyRegistryUrl}\n//${dependencyRegistryHost}/:_authToken=fixture-token\n`, { mode: 0o600 });
    const sourceRegistryHost = new URL(marketplaceSourceUrl).host;
    const userConfigPath = path.join(dir, 'user.npmrc');
    await fs.writeFile(userConfigPath, `@other:registry=${marketplaceSourceUrl}\n//${sourceRegistryHost}/:_authToken=user-fixture-token\n`, { mode: 0o600 });
    const store = createExtensionStore({ root: path.join(dir, 'kb-home'), platformRoot });

    // A user-level default registry can differ from the platform's scoped
    // routing. The platform's package-manager config must win for this scope.
    vi.stubEnv('NPM_CONFIG_REGISTRY', marketplaceSourceUrl);
    vi.stubEnv('npm_config_registry', marketplaceSourceUrl);
    vi.stubEnv('HOME', dir);
    vi.stubEnv('npm_config_userconfig', userConfigPath);
    const installed = await store.resolve({
      name: '@fixture/platform-plugin',
      version: '1.0.0',
      kind: 'plugin',
      spec: `${marketplaceSourceUrl}/platform-plugin.tgz`,
      expectedIntegrity: `sha512-${crypto.createHash('sha512').update(pluginTarball).digest('base64')}`,
      usePlatformNpmrc: true,
    });

    expect(installed.entry.name).toBe('@fixture/platform-plugin');
    expect(await fs.access(installed.packageRoot)).toBeUndefined();
    expect(sourceRequests).toContain('/platform-plugin.tgz');
    expect(dependencyRequests.some(requestPath => decodeURIComponent(requestPath).includes('@fixture/sdk'))).toBe(true);
    expect(dependencyRequests.some(requestPath => requestPath.endsWith('/sdk-1.0.0.tgz'))).toBe(true);
    expect(dependencyAuthSeen).toBe(true);
    expect(sourceRequests.some(requestPath => requestPath.includes('@other/sdk'))).toBe(true);
    expect(sourceRequests.some(requestPath => requestPath.endsWith('/sdk-1.0.0.tgz'))).toBe(true);
    expect(userConfigAuthSeen).toBe(true);
    await expect(fs.access(path.join(installed.entryDir, '.npmrc'))).rejects.toThrow();
  }, 60_000);

  // case: S-300.3
  it('keeps platform npmrc credentials out of project-scope dependency installs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-store-project-scope-registry-'));
    tempDirs.push(dir);
    const sourceRequests: string[] = [];
    const platformRequests: string[] = [];
    const sdkTarball = await packPackage(dir, '@fixture/sdk', '1.0.0');
    const sdkIntegrity = `sha512-${crypto.createHash('sha512').update(sdkTarball).digest('base64')}`;
    const sourceServer = createServer((request, response) => {
      const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      sourceRequests.push(requestPath);
      if (requestPath === '/project-plugin.tgz') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(pluginTarball);
        return;
      }
      if (requestPath.endsWith('/sdk-1.0.0.tgz')) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(sdkTarball);
        return;
      }
      if (requestPath.includes('@fixture/sdk')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          name: '@fixture/sdk',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: '@fixture/sdk',
              version: '1.0.0',
              dist: { tarball: `${sourceRegistryUrl}/@fixture/sdk/-/sdk-1.0.0.tgz`, integrity: sdkIntegrity },
            },
          },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    const sourceRegistryUrl = await listen(sourceServer);
    const pluginTarball = await packPackage(dir, '@fixture/project-plugin', '1.0.0', {
      dependencies: { '@fixture/sdk': '1.0.0' },
    });
    const platformServer = createServer((request, response) => {
      platformRequests.push(request.url ?? '/');
      response.writeHead(404).end();
    });
    const platformRegistryUrl = await listen(platformServer);
    const platformRoot = path.join(dir, 'platform');
    await fs.mkdir(platformRoot);
    const platformRegistryHost = new URL(platformRegistryUrl).host;
    await fs.writeFile(path.join(platformRoot, '.npmrc'), `@fixture:registry=${platformRegistryUrl}\n//${platformRegistryHost}/:_authToken=platform-secret-sentinel\n`, { mode: 0o600 });
    const emptyUserNpmrc = path.join(dir, 'empty-user.npmrc');
    await fs.writeFile(emptyUserNpmrc, '');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('NPM_CONFIG_USERCONFIG', emptyUserNpmrc);
    vi.stubEnv('npm_config_userconfig', emptyUserNpmrc);
    const store = createExtensionStore({ root: path.join(dir, 'kb-home'), platformRoot });

    const installed = await store.resolve({
      name: '@fixture/project-plugin',
      version: '1.0.0',
      kind: 'plugin',
      spec: `${sourceRegistryUrl}/project-plugin.tgz`,
      expectedIntegrity: `sha512-${crypto.createHash('sha512').update(pluginTarball).digest('base64')}`,
      registryUrl: sourceRegistryUrl,
    });

    expect(installed.entry.name).toBe('@fixture/project-plugin');
    expect(sourceRequests).toContain('/project-plugin.tgz');
    expect(sourceRequests.some(requestPath => requestPath.includes('@fixture/sdk'))).toBe(true);
    expect(sourceRequests.some(requestPath => requestPath.endsWith('/sdk-1.0.0.tgz'))).toBe(true);
    expect(platformRequests).toEqual([]);
  }, 60_000);
});

// case: S-300.4
it('does not return registry credentials or pnpm diagnostics in install errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-store-redacted-error-'));
  tempDirs.push(dir);
  const pnpmPath = path.join(dir, 'pnpm.mjs');
  const secretSentinel = 'fixture-secret-token-1234';
  await fs.writeFile(pnpmPath, `#!${process.execPath}\nprocess.stderr.write('Authorization settings: ${secretSentinel} username=fixture-user @fixture:registry=https://registry.invalid\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  let caught: unknown;
  try {
    await new PnpmInstaller({ pnpmPath }).install({
      name: '@fixture/plugin',
      version: '1.0.0',
      projectDir: path.join(dir, 'project'),
      casDir: path.join(dir, 'store'),
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({ code: 'KB_PLUGIN_INSTALL_FAILED' });
  const serialized = JSON.stringify((caught as { envelope?: unknown }).envelope);
  expect(serialized).toContain('exited with code 1');
  expect(serialized).not.toContain(secretSentinel);
  expect(serialized).not.toContain('fixture-user');
  expect(serialized).not.toContain('registry.invalid');
});

// case: S-268.16
it('rejects an extension tarball with a scoped runtime dependency before pnpm', async () => {
  const { dir, pnpmPath } = await createInstallerFixture();
  const packageDir = path.join(dir, 'package');
  await fs.mkdir(packageDir);
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@kb-labs/demo', version: '1.2.3', dependencies: { '@kb-labs/sdk': '1.2.3' } }));
  const archive = path.join(dir, 'package.tgz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
  const bytes = await fs.readFile(archive);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
  const projectDir = path.join(dir, 'project');
  await expect(new PnpmInstaller({ pnpmPath }).install({ name: '@kb-labs/demo', version: '1.2.3', spec: 'https://registry.example.test/demo.tgz', expectedIntegrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`, projectDir, casDir: path.join(dir, 'store') })).rejects.toMatchObject({ code: 'KB_PLUGIN_INSTALL_FAILED' });
  await expect(fs.access(path.join(projectDir, 'observed-spec.txt'))).rejects.toThrow();
});
