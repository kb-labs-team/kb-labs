import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  collectDeclaredEntries,
  defaultPackVerifyDeps,
  isAppPackage,
  resolveStagedArtifacts,
  runImportPass,
  runPackInstallCheck,
  runPackStaticCheck,
  type ImportEntry,
  type InstallRequest,
  type PackedManifest,
  type PackVerifyDeps,
  type StagedTarball,
} from '../pack-verify';
import { runReleaseChecks } from '../checks';
import { buildReleaseRunReport, classifyFailure } from '../run-report';
import type { CustomCheckConfig } from '../types';

let root: string;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pack-verify-test-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** Build a real .tgz with the `package/` prefix npm uses. */
function makeTarball(name: string, version: string, manifest: Record<string, unknown>, files: Record<string, string>): StagedTarball {
  const dir = join(root, `src-${name.replace(/[@/]/g, '_')}-${version}`);
  const pkgDir = join(dir, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, type: 'module', ...manifest }, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(pkgDir, rel, '..'), { recursive: true });
    writeFileSync(join(pkgDir, rel), body);
  }
  const tarball = join(root, `${name.replace(/[@/]/g, '_')}-${version}.tgz`);
  const res = spawnSync('tar', ['czf', tarball, '-C', dir, 'package']);
  if (res.status !== 0) { throw new Error(`tar failed: ${res.stderr.toString()}`); }
  return { name, version, tarball };
}

const okFiles = { 'dist/index.js': 'export const a = 1;\n', 'dist/index.d.ts': 'export declare const a: number;\n' };
const okManifest = { main: './dist/index.js', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } };

// ─── static checks ────────────────────────────────────────────────────────────

describe('pack-static (batch, real tar + node --check)', () => {
  it('passes a healthy tarball and reports every failing package with classifiable text', async () => {
    const good = makeTarball('@t/good', '1.0.0', okManifest, okFiles);
    const ws = makeTarball('@t/ws', '1.0.0', { ...okManifest, dependencies: { '@t/good': 'workspace:*' }, devDependencies: { x: 'link:../x' } }, okFiles);
    const missing = makeTarball('@t/missing', '1.0.0', { ...okManifest, exports: { '.': './dist/nope.js' } }, okFiles);
    const syntax = makeTarball('@t/syntax', '1.0.0', okManifest, { ...okFiles, 'dist/index.js': 'export const = ;\n' });
    const binMissing = makeTarball('@t/bin', '1.0.0', { ...okManifest, bin: { t: './dist/bin.js' } }, okFiles);

    const packages = [good, ws, missing, syntax, binMissing].map(a => ({ name: a.name, path: `/repo/${a.name}` }));
    const out = await runPackStaticCheck(packages, [good, ws, missing, syntax, binMissing], defaultPackVerifyDeps);

    const byPath = new Map(out.packages.map(p => [p.path, p]));
    expect(byPath.get('/repo/@t/good')?.ok).toBe(true);

    const wsErr = byPath.get('/repo/@t/ws')!;
    expect(wsErr.ok).toBe(false);
    expect(wsErr.details?.stderr).toContain('dependencies.@t/good=workspace:*');
    expect(wsErr.details?.stderr).toContain('devDependencies.x=link:../x');
    expect(classifyFailure({ stderr: wsErr.details?.stderr }).rule).toBe('workspace-protocol');

    const missErr = byPath.get('/repo/@t/missing')!;
    expect(missErr.details?.stderr).toContain("declared entry './dist/nope.js' missing from packed tarball");
    expect(classifyFailure({ stderr: missErr.details?.stderr }).rule).toBe('missing-export');

    const synErr = byPath.get('/repo/@t/syntax')!;
    expect(synErr.details?.stderr).toContain('failed syntax check');
    expect(classifyFailure({ stderr: synErr.details?.stderr }).rule).toBe('syntax-error');

    expect(byPath.get('/repo/@t/bin')?.details?.stderr).toContain("'./dist/bin.js' missing");
    expect(out.packages.filter(p => !p.ok)).toHaveLength(4);
    expect(out.phases[0]?.name).toBe('static-checks');
  });

  it('fails a package that has no staged tarball instead of silently passing it', async () => {
    const out = await runPackStaticCheck([{ name: '@t/ghost', path: '/repo/ghost' }], [], defaultPackVerifyDeps);
    expect(out.packages[0]?.ok).toBe(false);
    expect(out.packages[0]?.details?.stderr).toContain('no staged tarball found for @t/ghost');
  });

  it('collects main/module/types/bin/exports leaves and skips globs', () => {
    const entries = collectDeclaredEntries({
      main: './dist/i.js', bin: 'bin/x.js',
      exports: { '.': { import: './dist/i.js' }, './sub/*': './dist/sub/*.js', './p': ['./dist/p.js'] },
    });
    expect(entries.sort()).toEqual(['./dist/i.js', './dist/p.js', 'bin/x.js']);
  });
});

// ─── aggregated install with fakes ────────────────────────────────────────────

interface Fakes { deps: PackVerifyDeps; installs: InstallRequest[]; imports: ImportEntry[][] }

/**
 * `uninstallable` names make any install that contains them fail (like an
 * unresolvable dependency); `conflict` pairs fail only when installed together.
 */
function fakeDeps(opts: { uninstallable?: string[]; conflict?: [string, string]; manifests?: Record<string, PackedManifest>; importFails?: string[] } = {}): Fakes {
  const installs: InstallRequest[] = [];
  const imports: ImportEntry[][] = [];
  let clock = 0;
  const specName = (s: string): string => { const i = s.lastIndexOf('@'); return i > 0 ? s.slice(0, i) : s; };
  const deps: PackVerifyDeps = {
    ...defaultPackVerifyDeps,
    now: () => (clock += 10),
    createConsumer: () => ({ dir: '/fake-consumer', dispose: () => undefined }),
    readManifest: async tarball => opts.manifests?.[tarball] ?? {},
    async install(req) {
      installs.push(req);
      const names = req.specs.map(specName);
      const bad = names.find(n => opts.uninstallable?.includes(n));
      if (bad) { throw new Error(`install failed: [E404] 404 Not Found - GET /${bad}-dep`); }
      if (opts.conflict && opts.conflict.every(c => names.includes(c))) { throw new Error('install failed: [ERESOLVE] conflicting peer dependency'); }
    },
    async importPass(req) {
      imports.push(req.entries);
      return req.entries.map(e => opts.importFails?.includes(e.name) ? { name: e.name, ok: false, error: 'boom' } : { name: e.name, ok: true });
    },
  };
  return { deps, installs, imports };
}

function tarballs(...names: string[]): { artifacts: StagedTarball[]; packages: Array<{ name: string; path: string }> } {
  return {
    artifacts: names.map(n => ({ name: n, version: '2.0.0', tarball: n })),
    packages: names.map(n => ({ name: n, path: `/repo/${n}` })),
  };
}

describe('pack-install (aggregated)', () => {
  it('installs everything in ONE consumer from the staging registry and imports once', async () => {
    const { artifacts, packages } = tarballs('a', 'b', 'c', 'd');
    const f = fakeDeps();
    const out = await runPackInstallCheck({ packages, artifacts, registry: 'http://reg', config: {}, timeoutMs: 1000 }, f.deps);
    expect(f.installs).toHaveLength(1);
    expect(f.installs[0]?.specs).toEqual(['a@2.0.0', 'b@2.0.0', 'c@2.0.0', 'd@2.0.0']);
    expect(f.installs[0]?.registry).toBe('http://reg');
    expect(f.imports).toHaveLength(1);
    expect(out.packages.every(p => p.ok)).toBe(true);
    expect(out.phases.map(p => p.name)).toEqual(['aggregated-install+import']);
  });

  it('skips import() for app/daemon packages (declared list, bin, name) but still resolves them', async () => {
    const { artifacts, packages } = tarballs('lib', 'declared-app-x', 'with-bin', '@kb/mcp-app', 'plain');
    const f = fakeDeps({ manifests: { 'with-bin': { bin: { x: './dist/bin.js' } } } });
    await runPackInstallCheck({
      packages, artifacts, config: { appPackages: ['declared-app-x'] }, timeoutMs: 1000,
    }, f.deps);
    const modes = Object.fromEntries(f.imports[0]!.map(e => [e.name, e.mode]));
    expect(modes).toEqual({ lib: 'import', 'declared-app-x': 'resolve', 'with-bin': 'resolve', '@kb/mcp-app': 'resolve', plain: 'import' });
    expect(isAppPackage('lib', {}, { detectApps: false })).toBe(false);
    expect(isAppPackage('with-bin', { bin: 'x.js' }, { detectApps: false })).toBe(false);
  });

  it('reports a failing import per package', async () => {
    const { artifacts, packages } = tarballs('a', 'b');
    const f = fakeDeps({ importFails: ['b'] });
    const out = await runPackInstallCheck({ packages, artifacts, config: {}, timeoutMs: 1000 }, f.deps);
    expect(out.packages[0]?.ok).toBe(true);
    expect(out.packages[1]?.details?.stderr).toContain('clean consumer cannot import b: boom');
    expect(classifyFailure({ stderr: out.packages[1]?.details?.stderr }).rule).toBe('import-failed');
  });

  it('bisects a failed aggregated install down to the offending package', async () => {
    const { artifacts, packages } = tarballs('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    const f = fakeDeps({ uninstallable: ['f'] });
    const out = await runPackInstallCheck({ packages, artifacts, config: {}, timeoutMs: 1000 }, f.deps);
    const failed = out.packages.filter(p => !p.ok).map(p => p.path);
    expect(failed).toEqual(['/repo/f']);
    expect(out.packages.find(p => p.path === '/repo/f')?.details?.stderr).toContain('[E404]');
    expect(out.packages.filter(p => p.ok)).toHaveLength(7);
    // 1 aggregate + O(log n) bisect installs, far fewer than one per package.
    expect(f.installs.length).toBeLessThan(8);
    expect(out.phases.map(p => p.name)).toContain('bisect');
  });

  it('names every uninstallable package when several fail', async () => {
    const { artifacts, packages } = tarballs('a', 'b', 'c', 'd');
    const f = fakeDeps({ uninstallable: ['a', 'd'] });
    const out = await runPackInstallCheck({ packages, artifacts, config: {}, timeoutMs: 1000 }, f.deps);
    expect(out.packages.filter(p => !p.ok).map(p => p.path).sort()).toEqual(['/repo/a', '/repo/d']);
  });

  it('attributes an interaction failure to the whole subset when halves install alone', async () => {
    const { artifacts, packages } = tarballs('a', 'b');
    const f = fakeDeps({ conflict: ['a', 'b'] });
    const out = await runPackInstallCheck({ packages, artifacts, config: {}, timeoutMs: 1000 }, f.deps);
    expect(out.packages.every(p => !p.ok)).toBe(true);
    expect(out.packages[0]?.details?.stderr).toContain('installs alone but not together');
  });

  it('stops bisecting when the install budget is exhausted and says so', async () => {
    const { artifacts, packages } = tarballs('a', 'b', 'c', 'd');
    const f = fakeDeps({ uninstallable: ['c'] });
    const out = await runPackInstallCheck({ packages, artifacts, config: { maxBisectInstalls: 1 }, timeoutMs: 1000 }, f.deps);
    expect(out.packages.some(p => p.details?.stderr?.includes('bisect budget'))).toBe(true);
  });

  it('runs isolated installs only for configured and changed packages', async () => {
    const names = ['@kb/sdk', '@kb/platform-client', 'x1', 'x2', 'x3', 'x4'];
    const { artifacts, packages } = tarballs(...names);
    const f = fakeDeps();
    const out = await runPackInstallCheck({
      packages, artifacts, registry: 'http://reg', changedPackages: ['x2', 'x4', 'x3'],
      config: { isolatedPackages: ['@kb/sdk', '@kb/platform-client'], maxIsolatedChanged: 2 }, timeoutMs: 1000,
    }, f.deps);
    // aggregate + 2 configured + 2 changed (x2, x3 by name order; x4 truncated)
    const isolated = f.installs.slice(1).map(i => i.specs);
    expect(isolated.map(s => s[0]).sort()).toEqual(['@kb/platform-client@2.0.0', '@kb/sdk@2.0.0', 'x2@2.0.0', 'x3@2.0.0']);
    expect(isolated.every(s => s.length === 1)).toBe(true);
    const phase = out.phases.find(p => p.name === 'isolated-installs');
    expect(phase?.detail).toContain('2 configured, 2 changed');
    expect(phase?.detail).toContain('1 more changed package(s)');
  });

  it('a package failing only in isolation is reported', async () => {
    const { artifacts, packages } = tarballs('@kb/sdk', 'b');
    const f = fakeDeps();
    const original = f.deps.install;
    let calls = 0;
    f.deps.install = async req => {
      calls++;
      if (calls > 1 && req.specs[0]?.startsWith('@kb/sdk')) { throw new Error('install failed: [EUNSUPPORTEDPROTOCOL] Unsupported URL Type "workspace:"'); }
      return original(req);
    };
    const out = await runPackInstallCheck({ packages, artifacts, config: { isolatedPackages: ['@kb/sdk'] }, timeoutMs: 1000 }, f.deps);
    expect(out.packages[0]?.ok).toBe(false);
    expect(out.packages[0]?.details?.stderr).toContain('isolated clean consumer');
    expect(classifyFailure({ stderr: out.packages[0]?.details?.stderr }).rule).toBe('workspace-protocol');
    expect(out.packages[1]?.ok).toBe(true);
  });

  it('installs tarball paths when no staging registry is known', async () => {
    const { artifacts, packages } = tarballs('a');
    const f = fakeDeps();
    await runPackInstallCheck({ packages, artifacts, config: {}, timeoutMs: 1000 }, f.deps);
    expect(f.installs[0]?.specs).toEqual(['a']);
    expect(f.installs[0]?.registry).toBeUndefined();
  });

  it('turns an install that outlives its budget into a failure that classifies as a timeout', async () => {
    const { artifacts, packages } = tarballs('a');
    const f = fakeDeps();
    f.deps.install = () => new Promise(() => undefined);
    const out = await runPackInstallCheck({ packages, artifacts, config: {}, timeoutMs: 20 }, f.deps);
    expect(out.packages[0]?.ok).toBe(false);
    expect(classifyFailure({ error: out.packages[0]?.details?.stderr }).timedOut).toBe(true);
  });
});

// ─── real import pass (no network) ────────────────────────────────────────────

describe('runImportPass (real node process, fixture consumer)', () => {
  it('imports libraries, resolves apps without executing them, and isolates a crashing package', async () => {
    const consumer = join(root, 'consumer');
    const marker = join(root, 'app-was-imported');
    const mk = (name: string, body: string): void => {
      const dir = join(consumer, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js' }));
      writeFileSync(join(dir, 'index.js'), body);
    };
    mkdirSync(consumer, { recursive: true });
    mk('good', 'export const ok = 1;');
    mk('throws', 'throw new Error("cannot start");');
    mk('crashes', 'process.exit(3);');
    mk('hangs', 'await new Promise(() => undefined);');
    // Like @kb-labs/mcp-app: importing it starts a daemon (here: writes a marker and keeps the loop alive).
    mk('app', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => undefined, 1000);`);

    const outcomes = await runImportPass({
      consumerDir: consumer,
      entries: [
        { name: 'good', mode: 'import' },
        { name: 'app', mode: 'resolve' },
        { name: 'throws', mode: 'import' },
        { name: 'crashes', mode: 'import' },
        { name: 'hangs', mode: 'import' },
        { name: 'missing', mode: 'resolve' },
      ],
      perImportTimeoutMs: 500,
      totalTimeoutMs: 30_000,
    });
    const by = (n: string): typeof outcomes => outcomes.filter(o => o.name === n);
    expect(by('good').every(o => o.ok)).toBe(true);
    expect(by('app')[0]?.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(by('throws')[0]?.error).toContain('cannot start');
    expect(by('crashes')[0]).toMatchObject({ ok: false });
    expect(by('crashes')[0]?.error).toContain('exited with code 3');
    expect(by('hangs')[0]?.error).toContain('timed out');
    expect(by('missing')[0]?.ok).toBe(false);
    expect(outcomes).toHaveLength(6);
  });
});

// ─── artifact resolution ──────────────────────────────────────────────────────

describe('resolveStagedArtifacts', () => {
  it('reuses tarballs from the Stage manifest without packing or fetching', async () => {
    const a = makeTarball('@t/staged', '3.0.0', okManifest, okFiles);
    const dir = join(root, 'staged');
    mkdirSync(dir, { recursive: true });
    spawnSync('cp', [a.tarball, join(dir, 'staged.tgz')]);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify([{ name: '@t/staged', version: '3.0.0', tarball: 'staged.tgz' }]));
    const fetchImpl = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    const res = await resolveStagedArtifacts({ packages: [{ name: '@t/staged', version: '3.0.0' }], stagedDir: dir, registry: 'http://reg', fetchImpl });
    expect(res.source).toBe('staged-dir');
    expect(res.artifacts[0]?.tarball).toBe(join(dir, 'staged.tgz'));
  });

  it('falls back to downloading the same tarball from the staging registry', async () => {
    const a = makeTarball('@t/remote', '4.0.0', okManifest, okFiles);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.endsWith('%2fremote')) {
        return new Response(JSON.stringify({ versions: { '4.0.0': { dist: { tarball: 'http://reg/tarball.tgz' } } } }), { status: 200 });
      }
      const bytes = spawnSync('cat', [a.tarball]).stdout;
      return new Response(new Uint8Array(bytes), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await resolveStagedArtifacts({ packages: [{ name: '@t/remote', version: '4.0.0' }], stagedDir: join(root, 'none'), registry: 'http://reg', fetchImpl });
    expect(res.source).toBe('registry');
    expect(existsSync(res.artifacts[0]!.tarball)).toBe(true);
    expect(seen[0]).toBe('http://reg/@t%2fremote');
    // the downloaded tarball is a valid artifact
    const out = await runPackStaticCheck([{ name: '@t/remote', path: '/r' }], res.artifacts, defaultPackVerifyDeps);
    expect(out.packages[0]?.ok).toBe(true);
    rmSync(res.artifacts[0]!.tarball, { force: true });
  });

  it('leaves missing packages unresolved so the checks can name them', async () => {
    const res = await resolveStagedArtifacts({ packages: [{ name: '@t/none', version: '1.0.0' }], stagedDir: join(root, 'nothing') });
    expect(res).toEqual({ artifacts: [], source: 'none' });
  });
});

// ─── wiring: runReleaseChecks + run report ────────────────────────────────────

describe('runReleaseChecks with builtin pack checks', () => {
  const shell = { exec: async () => ({ code: 0, stdout: '', stderr: '', ok: true }) };

  function pkgDir(name: string): string {
    const dir = join(root, 'ws', name.replace(/[@/]/g, '_'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    return dir;
  }

  it('skips pack-install only for packages that failed the blocking pack-static, keeps phases and report rows', async () => {
    const good = makeTarball('@w/good', '1.0.0', okManifest, okFiles);
    const bad = makeTarball('@w/bad', '1.0.0', { ...okManifest, dependencies: { '@w/good': 'workspace:*' } }, okFiles);
    const goodDir = pkgDir('@w/good');
    const badDir = pkgDir('@w/bad');
    const installs: InstallRequest[] = [];
    const f = fakeDeps();
    const deps: Partial<PackVerifyDeps> = {
      ...f.deps,
      readManifest: async () => ({}),
      install: async req => { installs.push(req); },
    };
    const checks: CustomCheckConfig[] = [
      { id: 'pack-static', builtin: 'pack-static', blocking: true, runIn: 'perPackage' },
      { id: 'pack-install', builtin: 'pack-install', dependsOn: ['pack-static'], runIn: 'perPackage', packInstall: { isolateChanged: false } },
    ];
    const staged = join(root, 'wiring');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'manifest.json'), JSON.stringify([good, bad].map(a => ({ ...a, tarball: relative(staged, a.tarball) }))));
    const results = await runReleaseChecks(checks, {
      repoRoot: root,
      packagePaths: [goodDir, badDir],
      shell,
      pack: {
        plannedPackages: [{ name: '@w/good', version: '1.0.0' }, { name: '@w/bad', version: '1.0.0' }],
        stagedDir: staged,
        deps: { ...deps, extract: defaultPackVerifyDeps.extract },
        registry: 'http://reg',
      },
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.packages?.find(p => p.path === badDir)?.details?.stderr).toContain('workspace-only dependency protocols');
    expect(results[0]?.phases?.map(p => p.name)).toContain('static-checks');
    expect(results[1]?.packages?.find(p => p.path === badDir)?.skipped).toBe(true);
    expect(results[1]?.packages?.find(p => p.path === goodDir)?.ok).toBe(true);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.specs).toEqual(['@w/good@1.0.0']);

    const report = buildReleaseRunReport({
      results,
      packages: [{ name: '@w/good', path: goodDir }, { name: '@w/bad', path: badDir }],
    });
    expect(report.stages.map(s => s.stage)).toEqual(expect.arrayContaining(['pack-static:static-checks', 'pack-install:aggregated-install+import']));
    expect(report.checks.find(c => c.id === 'pack-static')?.phases?.length).toBeGreaterThan(0);
    const fail = report.failures.find(x => x.package === '@w/bad');
    expect(fail?.rule).toBe('workspace-protocol');
    expect(report.skipped.some(s => s.checkId === 'pack-install' && s.packagePath === badDir)).toBe(true);
  });

  it('does not run disabled checks unless requested with `only`', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'legacy', command: 'false', runIn: 'repoRoot', disabled: true },
      { id: 'other', command: 'true', runIn: 'repoRoot' },
    ];
    const normal = await runReleaseChecks(checks, { repoRoot: root, packagePaths: [], shell });
    expect(normal.map(r => r.id)).toEqual(['other']);
    const only = await runReleaseChecks(checks, { repoRoot: root, packagePaths: [], shell, only: ['legacy'] });
    expect(only.map(r => r.id)).toEqual(['legacy']);
  });

  it('fails clearly when no staging information is available', async () => {
    const dir = pkgDir('@w/nostage');
    const results = await runReleaseChecks([{ id: 'pack-static', builtin: 'pack-static', runIn: 'perPackage' }], { repoRoot: root, packagePaths: [dir], shell });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.details?.stderr).toContain('release stage plan');
  });
});

describe('real Arborist in-process install (offline, dependency-free tarballs)', () => {
  it('installs two tarballs into one consumer and imports them in one pass', async () => {
    const a = makeTarball('@t/real-a', '1.0.0', okManifest, okFiles);
    const b = makeTarball('@t/real-b', '1.0.0', okManifest, okFiles);
    const out = await runPackInstallCheck({
      packages: [a, b].map(x => ({ name: x.name, path: `/r/${x.name}` })),
      artifacts: [a, b],
      config: { isolateChanged: false },
      timeoutMs: 120_000,
    }, defaultPackVerifyDeps);
    expect(out.packages.map(p => p.ok)).toEqual([true, true]);
  }, 150_000);

  it('surfaces a real install error (workspace: dependency) and bisects to the offending package', async () => {
    const good = makeTarball('@t/real-ok', '1.0.0', okManifest, okFiles);
    const bad = makeTarball('@t/real-bad', '1.0.0', { ...okManifest, dependencies: { '@t/dep': 'workspace:*' } }, okFiles);
    const out = await runPackInstallCheck({
      packages: [good, bad].map(x => ({ name: x.name, path: `/r/${x.name}` })),
      artifacts: [good, bad],
      config: { isolateChanged: false },
      timeoutMs: 120_000,
    }, defaultPackVerifyDeps);
    expect(out.packages[0]?.ok).toBe(true);
    expect(out.packages[1]?.ok).toBe(false);
    expect(out.packages[1]?.details?.stderr).toMatch(/EUNSUPPORTEDPROTOCOL|workspace/);
  }, 150_000);
});
