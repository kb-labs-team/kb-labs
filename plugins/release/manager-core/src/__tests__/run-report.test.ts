import { describe, it, expect } from 'vitest';
import type { CheckResult } from '../types';
import {
  classifyFailure,
  buildReleaseRunReport,
  renderRunReportMarkdown,
  renderFailureLines,
  redact,
  createReleaseError,
  describeReleaseError,
  KB_RELEASE_CODES,
} from '../run-report';

// Real-looking failures, modelled on scripts/gates/check-pack-install.sh output
// and on the GovernedProcessError shape produced by checks.ts.
const TIMEOUT_PARTIAL: CheckResult['details'] = {
  packagePath: '/repo/core/core-runtime',
  error: 'Process terminated: timeout',
  stdout: 'Packing @kb-labs/core-runtime...\nExtracting kb-labs-core-runtime-2.121.0.tgz...\n  OK: dist/index.js\nInstalling packed artifact into a clean consumer...\n',
};
const REGISTRY_DOWN: CheckResult['details'] = {
  packagePath: '/repo/sdk/sdk',
  exitCode: 1,
  error: 'exit code 1',
  stdout: 'Packing @kb-labs/sdk...\nChecking staging registry at http://localhost:4873...\n',
  stderr:
    '\nERROR: local staging registry unreachable at http://localhost:4873\n' +
    "  pack-install needs the release plan's packages staged there first.\n" +
    '  Run: ./tools/kb-dev/kb-dev ensure verdaccio --config .kb/devservices.dev.yaml --net-offset 0\n',
};
const WORKSPACE_PROTOCOL: CheckResult['details'] = {
  packagePath: '/repo/plugins/release/manager-core',
  exitCode: 1,
  error: 'exit code 1',
  stderr:
    'ERROR: packed manifest contains workspace-only dependency protocols:\n' +
    '  dependencies.@kb-labs/sdk=workspace:*\n',
};

describe('classifyFailure', () => {
  it('workspace: protocol in packed manifest -> package-content', () => {
    const v = classifyFailure(WORKSPACE_PROTOCOL ?? {});
    expect(v.classification).toBe('package-content');
    expect(v.rule).toBe('workspace-protocol');
    expect(v.rootCause).toContain('dependencies.@kb-labs/sdk=workspace:*');
  });

  it('EUNSUPPORTEDPROTOCOL from a clean install -> package-content', () => {
    const v = classifyFailure({ stderr: 'Error: EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:": workspace:*' });
    expect(v.rule).toBe('workspace-protocol');
  });

  it('missing declared entry -> package-content, names the entry', () => {
    const v = classifyFailure({ stderr: "ERROR: declared entry './dist/index.js' missing from packed tarball" });
    expect(v.classification).toBe('package-content');
    expect(v.rule).toBe('missing-export');
    expect(v.rootCause).toContain('./dist/index.js');
  });

  it('unreachable staging registry -> environment with REGISTRY_UNREACHABLE and a start command', () => {
    const v = classifyFailure(REGISTRY_DOWN ?? {});
    expect(v.classification).toBe('environment');
    expect(v.code).toBe('KB_RELEASE_REGISTRY_UNREACHABLE');
    expect(v.rootCause).toContain('http://localhost:4873');
    expect(v.hint).toContain('kb-dev ensure verdaccio');
  });

  it('PROCESS_TIMEOUT with partial stdout and no other evidence -> suspected-flake / CHECK_TIMEOUT', () => {
    const v = classifyFailure(TIMEOUT_PARTIAL ?? {});
    expect(v.classification).toBe('suspected-flake');
    expect(v.code).toBe('KB_RELEASE_CHECK_TIMEOUT');
    expect(v.timedOut).toBe(true);
    expect(v.rootCause).toContain('partial output');
  });

  it('timeout with no output says nothing was captured', () => {
    const v = classifyFailure({ error: 'PROCESS_TIMEOUT' });
    expect(v.rootCause).toContain('no output was captured');
  });

  it('precedence: content evidence beats a timeout', () => {
    const v = classifyFailure({ error: 'Process terminated: timeout', stderr: 'declared entry \'x.js\' missing from packed tarball' });
    expect(v.classification).toBe('package-content');
    expect(v.timedOut).toBe(true);
  });

  it('precedence: unreachable registry beats a timeout', () => {
    const v = classifyFailure({ error: 'Process terminated: timeout', stderr: 'staging registry unreachable at http://x:1' });
    expect(v.classification).toBe('environment');
  });

  it('ENOSPC and exit 137 -> ci-infrastructure', () => {
    expect(classifyFailure({ stderr: 'npm ERR! ENOSPC: no space left on device' }).classification).toBe('ci-infrastructure');
    expect(classifyFailure({ exitCode: 137, error: 'exit code 137' }).classification).toBe('ci-infrastructure');
  });

  it('ECONNRESET -> suspected-flake, ECONNREFUSED -> environment', () => {
    expect(classifyFailure({ stderr: 'read ECONNRESET' }).classification).toBe('suspected-flake');
    expect(classifyFailure({ stderr: 'connect ECONNREFUSED 127.0.0.1:4873' }).classification).toBe('environment');
  });

  it('bare `exit code N` with no output -> unknown, honestly', () => {
    const v = classifyFailure({ error: 'exit code 3', exitCode: 3 });
    expect(v.classification).toBe('unknown');
    expect(v.rootCause).toContain('exit code 3');
  });
});

describe('buildReleaseRunReport', () => {
  const results: CheckResult[] = [
    { id: 'dist-exports', ok: true, timingMs: 500 },
    {
      id: 'pack-install',
      ok: false,
      timingMs: 90_000,
      details: REGISTRY_DOWN,
      packages: [
        { path: '/repo/core/core-runtime', ok: false, details: TIMEOUT_PARTIAL },
        { path: '/repo/core/config', ok: true },
        { path: '/repo/sdk/sdk', ok: false, details: REGISTRY_DOWN },
        { path: '/repo/plugins/release/manager-core', ok: false, details: WORKSPACE_PROTOCOL },
      ],
    },
    { id: 'lint-docs', ok: false, optional: true, timingMs: 5, details: { error: 'exit code 2', exitCode: 2 } },
  ];

  const report = buildReleaseRunReport({
    results,
    flow: 'platform',
    packages: [
      { name: '@kb-labs/core-runtime', path: '/repo/core/core-runtime' },
      { name: '@kb-labs/sdk', path: '/repo/sdk/sdk' },
      { name: '@kb-labs/release-manager-core', path: '/repo/plugins/release/manager-core' },
    ],
    now: new Date('2026-09-26T10:00:00Z'),
  });

  it('surfaces ALL failing packages, not only the first', () => {
    const packInstall = report.failures.filter(f => f.checkId === 'pack-install');
    expect(packInstall.map(f => f.package).sort()).toEqual([
      '@kb-labs/core-runtime',
      '@kb-labs/release-manager-core',
      '@kb-labs/sdk',
    ]);
  });

  it('classifies each failure independently and counts them', () => {
    const byPkg = Object.fromEntries(report.failures.map(f => [f.package, f.classification]));
    expect(byPkg['@kb-labs/core-runtime']).toBe('suspected-flake');
    expect(byPkg['@kb-labs/sdk']).toBe('environment');
    expect(byPkg['@kb-labs/release-manager-core']).toBe('package-content');
    expect(report.summary.byClassification).toMatchObject({ 'suspected-flake': 1, environment: 1, 'package-content': 1, unknown: 1 });
  });

  it('separates blocking from optional failures and keeps ok=false', () => {
    expect(report.summary.blockingFailures).toBe(3);
    expect(report.summary.optionalFailures).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.failures.find(f => f.checkId === 'lint-docs')?.error.severity).toBe('warning');
  });

  it('report.ok is true when only optional checks failed', () => {
    const r = buildReleaseRunReport({ results: [{ id: 'x', ok: false, optional: true, details: { error: 'boom' } }] });
    expect(r.ok).toBe(true);
  });

  it('groups by package and builds a stage table with summed durations', () => {
    expect(report.byPackage.map(g => g.package)).toContain('@kb-labs/sdk');
    expect(report.stages).toEqual([{ stage: 'checks', status: 'failed', durationMs: 90_505, log: undefined }]);
    expect(report.checks.find(c => c.id === 'pack-install')).toMatchObject({ status: 'failed', failedPackages: 3 });
  });

  it('attaches envelope-compatible errors with resume action', () => {
    const f = report.failures.find(x => x.package === '@kb-labs/sdk')!;
    expect(f.error).toMatchObject({ code: 'KB_RELEASE_REGISTRY_UNREACHABLE', area: 'release', stage: 'preflight', retryable: true });
    expect(f.resumeCommand).toBe('pnpm kb release checks --flow platform');
    expect(f.error.actions?.[0]?.command).toBe(f.resumeCommand);
  });

  it('is JSON-serialisable without loss', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(JSON.parse(JSON.stringify(report)).failures).toHaveLength(4);
  });

  it('keeps partial stdout of a timeout as a redacted excerpt', () => {
    const f = report.failures.find(x => x.package === '@kb-labs/core-runtime')!;
    expect(f.timedOut).toBe(true);
    expect(f.outputExcerpt).toContain('Installing packed artifact into a clean consumer');
  });
});

describe('renderRunReportMarkdown', () => {
  const report = buildReleaseRunReport({
    results: [{ id: 'pack-install', ok: false, details: REGISTRY_DOWN, timingMs: 2500 }],
    flow: 'platform',
    now: new Date('2026-09-26T10:00:00Z'),
  });
  const md = renderRunReportMarkdown(report);

  it('renders stage table, failure section and next command', () => {
    expect(md).toContain('# Release run report');
    expect(md).toContain('| Stage | Status | Duration | Log |');
    expect(md).toContain('| checks | failed | 2.5s | - |');
    expect(md).toContain('**environment**');
    expect(md).toContain('KB_RELEASE_REGISTRY_UNREACHABLE');
    expect(md).toContain('`pnpm kb release checks --flow platform`');
  });

  it('renders a clean report without a failures section', () => {
    const ok = renderRunReportMarkdown(buildReleaseRunReport({ results: [{ id: 'a', ok: true, timingMs: 1 }] }));
    expect(ok).toContain('PASSED');
    expect(ok).toContain('No failures.');
  });

  it('renderFailureLines gives cause, hint and next', () => {
    const lines = renderFailureLines(report.failures);
    expect(lines[0]).toContain('pack-install');
    expect(lines.some(l => l.startsWith('  Cause:'))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/^Next: /);
  });
});

describe('redact', () => {
  it('removes tokens and home paths', () => {
    const out = redact('//registry/:_authToken=abc123secret\nnpm_abcdefghijklmnopqrstuvwx at /Users/kirill/work/x');
    expect(out).not.toContain('abc123secret');
    expect(out).not.toContain('npm_abcdefghijklmnopqrstuvwx');
    expect(out).not.toContain('/Users/kirill');
    expect(out).toContain('~/work/x');
  });
});

describe('KB_RELEASE codes', () => {
  it('covers every code from 09 §3.1 with envelope field names', () => {
    for (const code of [
      'KB_RELEASE_BRANCH_NOT_MASTER', 'KB_RELEASE_TREE_DIRTY', 'KB_RELEASE_DOCKER_UNAVAILABLE',
      'KB_RELEASE_REGISTRY_UNREACHABLE', 'KB_RELEASE_TOKEN_MISSING', 'KB_RELEASE_BASELINE_DRIFT',
      'KB_RELEASE_PLAN_INVALID', 'KB_RELEASE_STAGING_FAILED', 'KB_RELEASE_CHECK_FAILED',
      'KB_RELEASE_CHECK_TIMEOUT', 'KB_RELEASE_GIT_PUSH_REJECTED', 'KB_RELEASE_INDEX_SEAL_FAILED',
      'KB_RELEASE_BUILD_FAILED', 'KB_RELEASE_REGISTRY_BINDING_FAILED', 'KB_RELEASE_SMOKE_FAILED',
      'KB_RELEASE_PROMOTE_FAILED',
    ]) {
      expect(KB_RELEASE_CODES).toContain(code);
    }
    const e = createReleaseError({ code: 'KB_RELEASE_PROMOTE_FAILED', hint: 'x' });
    expect(Object.keys(e).sort()).toEqual(['area', 'code', 'hint', 'message', 'retryable', 'severity', 'stage']);
    expect(e.area).toBe('release');
  });

  it('codes are unique and namespaced; every code has a catalog entry', () => {
    expect(new Set(KB_RELEASE_CODES).size).toBe(KB_RELEASE_CODES.length);
    for (const c of KB_RELEASE_CODES) {
      expect(c.startsWith('KB_RELEASE_')).toBe(true);
      expect(describeReleaseError(c).message.length).toBeGreaterThan(0);
    }
  });
});
