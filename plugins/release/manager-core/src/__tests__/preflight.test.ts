import { describe, it, expect } from 'vitest';
import type { ReleaseShell } from '../types';
import {
  runReleasePreflight,
  buildReleaseRunReport,
  renderRunReportMarkdown,
  resolveStagingRegistry,
  type PreflightBaseline,
  type PreflightFetch,
  type PreflightOptions,
} from '../run-report';

type Reply = { code?: number; stdout?: string; stderr?: string };

/** Shell fake keyed by "cmd arg0 arg1"; unknown commands fail loudly. */
function fakeShell(replies: Record<string, Reply | Error>): ReleaseShell & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(command, args = []) {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const hit = Object.entries(replies).find(([k]) => key.startsWith(k));
      if (!hit) { throw new Error(`unexpected command: ${key}`); }
      if (hit[1] instanceof Error) { throw hit[1]; }
      const r = hit[1];
      const code = r.code ?? 0;
      return { code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ok: code === 0 };
    },
  };
}

const GREEN_SHELL = {
  'git rev-parse': { stdout: 'master\n' },
  'git status': { stdout: '' },
  'docker info': { stdout: '27.1.1\n' },
  'gh auth status': { stdout: 'Logged in' },
};

const upFetch: PreflightFetch = async () => ({ ok: true, status: 200 });

function opts(over: Partial<PreflightOptions> & { shell?: ReleaseShell }): PreflightOptions {
  return {
    cwd: '/repo',
    shell: over.shell ?? fakeShell(GREEN_SHELL),
    fetch: upFetch,
    env: { GH_TOKEN: 'ghp_SECRETSECRETSECRETSECRET1234' },
    ...over,
  };
}

const BASELINE_OK: PreflightBaseline = {
  gitTag: 'platform-v2.120.1', gitVersion: '2.120.1', npmStableVersion: '2.120.1',
  npmStableDistTag: 'latest', npmDrift: false, npmUnresolved: false,
};

function failed(r: Awaited<ReturnType<typeof runReleasePreflight>>) {
  return r.checks.filter(c => c.status === 'failed');
}

describe('runReleasePreflight', () => {
  it('all green: ok, every check passed, baseline skipped without a source', async () => {
    const r = await runReleasePreflight(opts({ baseline: async () => BASELINE_OK }));
    expect(r.ok).toBe(true);
    expect(r.checks.map(c => c.status)).toEqual(Array(7).fill('passed'));
  });

  it('baseline check is skipped when no source is provided', async () => {
    const r = await runReleasePreflight(opts({}));
    expect(r.ok).toBe(true);
    expect(r.checks.find(c => c.id === 'baseline-drift')?.status).toBe('skipped');
  });

  it('wrong branch -> KB_RELEASE_BRANCH_NOT_MASTER naming both branches', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'git rev-parse': { stdout: 'feature/x\n' } });
    const r = await runReleasePreflight(opts({ shell }));
    const [f] = failed(r);
    expect(f?.error?.code).toBe('KB_RELEASE_BRANCH_NOT_MASTER');
    expect(f?.error?.cause).toContain("'feature/x'");
    expect(f?.error?.hint).toContain('git switch master');
    expect(r.ok).toBe(false);
  });

  it('dirty tree -> KB_RELEASE_TREE_DIRTY with count', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'git status': { stdout: ' M a.ts\n?? b.ts\n' } });
    const [f] = failed(await runReleasePreflight(opts({ shell })));
    expect(f?.error?.code).toBe('KB_RELEASE_TREE_DIRTY');
    expect(f?.message).toContain('2 uncommitted');
  });

  it('only tool-generated .kb dirt -> passes with a warning and the count', async () => {
    const stdout = [
      ' M .kb/lock.json', ' M .kb/release/CHANGELOG.md', ' M core/bundle/.kb/lock.json',
      ' M plugins/review/entry/.kb/cache/cli-manifests.json', '?? sdk/platform-client/.kb/', '?? .kb/release/candidates/',
    ].join('\n') + '\n';
    const r = await runReleasePreflight(opts({ shell: fakeShell({ ...GREEN_SHELL, 'git status': { stdout } }) }));
    const c = r.checks.find(x => x.id === 'clean-tree');
    expect(r.ok).toBe(true);
    expect(c?.status).toBe('passed');
    expect(c?.warnings).toEqual(['6 tool-generated .kb file(s) modified or untracked (ignored)']);
  });

  it('a source file change fails and names it', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'git status': { stdout: ' M plugins/release/manager-core/src/x.ts\n' } });
    const [f] = failed(await runReleasePreflight(opts({ shell })));
    expect(f?.error?.code).toBe('KB_RELEASE_TREE_DIRTY');
    expect(f?.error?.cause).toContain('plugins/release/manager-core/src/x.ts');
  });

  it('mixed dirt fails listing only blocking paths, capped at 10', async () => {
    const src = Array.from({ length: 12 }, (_, i) => `?? src/f${i}.ts`);
    const stdout = [' M .kb/lock.json', ...src, 'R  old.ts -> .kb/moved.ts'].join('\n') + '\n';
    const [f] = failed(await runReleasePreflight(opts({ shell: fakeShell({ ...GREEN_SHELL, 'git status': { stdout } }) })));
    expect(f?.message).toBe('12 uncommitted change(s)');
    expect(f?.error?.cause).not.toContain('.kb/lock.json');
    expect(f?.error?.cause).toContain('src/f9.ts');
    expect(f?.error?.cause).not.toContain('src/f10.ts');
    expect(f?.error?.cause).toContain('and 2 more');
  });

  it('docker down -> KB_RELEASE_DOCKER_UNAVAILABLE', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'docker info': { code: 1, stderr: 'Cannot connect' } });
    const [f] = failed(await runReleasePreflight(opts({ shell })));
    expect(f?.error?.code).toBe('KB_RELEASE_DOCKER_UNAVAILABLE');
  });

  it('docker binary missing (exec throws) still yields a coded failure, not a crash', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'docker info': new Error('spawn docker ENOENT') });
    const [f] = failed(await runReleasePreflight(opts({ shell })));
    expect(f?.id).toBe('docker');
    expect(f?.error?.code).toBe('KB_RELEASE_DOCKER_UNAVAILABLE');
    expect(f?.error?.cause).toContain('ENOENT');
  });

  it('staging registry unreachable -> exact kb-dev command with the net offset, nothing started', async () => {
    const shell = fakeShell(GREEN_SHELL);
    const seen: string[] = [];
    const fetchFn: PreflightFetch = async (url) => {
      seen.push(url);
      if (url.includes(':4973')) { throw new Error('connect ECONNREFUSED 127.0.0.1:4973'); }
      return { ok: true, status: 200 };
    };
    const r = await runReleasePreflight(opts({ shell, fetch: fetchFn, netOffset: 100 }));
    const [f] = failed(r);
    expect(seen).toContain('http://localhost:4973/-/ping');
    expect(f?.id).toBe('staging-registry');
    expect(f?.error?.code).toBe('KB_RELEASE_REGISTRY_UNREACHABLE');
    expect(f?.error?.hint).toContain('./tools/kb-dev/kb-dev ensure verdaccio --config .kb/devservices.dev.yaml --net-offset 100');
    expect(shell.calls.every(c => !c.includes('kb-dev'))).toBe(true);
  });

  it('npm registry unreachable (HTTP 503) -> REGISTRY_UNREACHABLE with target=npm', async () => {
    const fetchFn: PreflightFetch = async (url) =>
      url.startsWith('https://registry.npmjs.org') ? { ok: false, status: 503 } : { ok: true, status: 200 };
    const [f] = failed(await runReleasePreflight(opts({ fetch: fetchFn })));
    expect(f?.id).toBe('npm-registry');
    expect(f?.error?.details?.target).toBe('npm');
    expect(f?.error?.cause).toContain('HTTP 503');
  });

  it('no token and gh not logged in -> KB_RELEASE_TOKEN_MISSING', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'gh auth status': { code: 1, stderr: 'not logged in' } });
    const [f] = failed(await runReleasePreflight(opts({ shell, env: {} })));
    expect(f?.error?.code).toBe('KB_RELEASE_TOKEN_MISSING');
  });

  it('gh login alone satisfies auth; env token never reaches the output', async () => {
    const r = await runReleasePreflight(opts({ env: {} }));
    expect(r.checks.find(c => c.id === 'github-auth')?.message).toBe('gh is authenticated');
    const withEnv = await runReleasePreflight(opts({}));
    expect(JSON.stringify(withEnv)).not.toContain('SECRETSECRET');
    expect(withEnv.checks.find(c => c.id === 'github-auth')?.message).toBe('Token present via GH_TOKEN');
  });

  it('git tag vs npm mismatch -> KB_RELEASE_BASELINE_DRIFT', async () => {
    const baseline = async () => ({ ...BASELINE_OK, npmStableVersion: '2.119.0' });
    const [f] = failed(await runReleasePreflight(opts({ baseline })));
    expect(f?.error?.code).toBe('KB_RELEASE_BASELINE_DRIFT');
    expect(f?.error?.cause).toContain('2.120.1');
    expect(f?.error?.cause).toContain('2.119.0');
  });

  it('packages disagreeing on the stable dist-tag -> BASELINE_DRIFT', async () => {
    const baseline = async () => ({ ...BASELINE_OK, npmStableVersion: null, npmDrift: true });
    const [f] = failed(await runReleasePreflight(opts({ baseline })));
    expect(f?.error?.code).toBe('KB_RELEASE_BASELINE_DRIFT');
  });

  it('unresolved npm baseline or a throwing baseline is skipped, not a false drift', async () => {
    const unresolved = await runReleasePreflight(opts({ baseline: async () => ({ ...BASELINE_OK, npmStableVersion: null, npmUnresolved: true }) }));
    expect(unresolved.checks.find(c => c.id === 'baseline-drift')?.status).toBe('skipped');
    const thrown = await runReleasePreflight(opts({ baseline: async () => { throw new Error('boom'); } }));
    expect(thrown.checks.find(c => c.id === 'baseline-drift')?.status).toBe('skipped');
    expect(thrown.ok).toBe(true);
  });

  it('reports every failure at once and all are environment-classified with envelope fields', async () => {
    const shell = fakeShell({
      'git rev-parse': { stdout: 'dev\n' },
      'git status': { stdout: ' M x\n' },
      'docker info': { code: 1 },
      'gh auth status': { code: 1 },
    });
    const r = await runReleasePreflight(opts({ shell, env: {}, fetch: async () => { throw new Error('offline'); } }));
    expect(failed(r).map(c => c.id).sort()).toEqual(['branch', 'clean-tree', 'docker', 'github-auth', 'npm-registry', 'staging-registry']);
    for (const c of failed(r)) {
      expect(c.error).toMatchObject({ area: 'release', stage: expect.any(String), severity: 'error', details: { classification: 'environment' } });
      expect(c.error?.hint).toBeTruthy();
      expect(c.error?.actions?.[0]?.command).toBe('pnpm kb release preflight');
    }
  });
});

describe('resolveStagingRegistry', () => {
  it('prefers explicit, then env, then 4873 + offset', () => {
    expect(resolveStagingRegistry({ stagingRegistry: 'http://a:1/', env: {} })).toBe('http://a:1');
    expect(resolveStagingRegistry({ env: { KB_RELEASE_STAGING_REGISTRY: 'http://b:2' } })).toBe('http://b:2');
    expect(resolveStagingRegistry({ netOffset: 100, env: {} })).toBe('http://localhost:4973');
    expect(resolveStagingRegistry({ env: {} })).toBe('http://localhost:4873');
  });
});

describe('preflight in ReleaseRunReport', () => {
  it('adds a preflight stage row, environment failures, and marks checks not-run', async () => {
    const shell = fakeShell({ ...GREEN_SHELL, 'docker info': { code: 1 } });
    const pre = await runReleasePreflight(opts({ shell, flow: 'platform' }));
    const report = buildReleaseRunReport({ results: [], preflight: pre, flow: 'platform' });
    expect(report.ok).toBe(false);
    expect(report.stages.map(s => `${s.stage}:${s.status}`)).toEqual(['preflight:failed', 'checks:not-run']);
    expect(report.failures[0]).toMatchObject({ classification: 'environment', checkId: 'preflight:docker' });
    expect(report.failures[0]?.resumeCommand).toBe('pnpm kb release preflight --flow platform');
    expect(renderRunReportMarkdown(report)).toContain('| preflight | failed |');
  });

  it('green preflight followed by checks keeps both rows', async () => {
    const pre = await runReleasePreflight(opts({}));
    const report = buildReleaseRunReport({ results: [{ id: 'a', ok: true, timingMs: 1 }], preflight: pre });
    expect(report.stages.map(s => `${s.stage}:${s.status}`)).toEqual(['preflight:passed', 'checks:passed']);
    expect(report.ok).toBe(true);
  });
});
