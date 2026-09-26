import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runReleaseChecks as runReleaseChecksCore } from '../checks';
import type { CustomCheckConfig } from '../types';
import { execa, execaCommand } from 'execa';

const testShell = {
  async exec(command: string, args: string[] = [], options: { cwd?: string; timeout?: number } = {}) {
    try {
      const result = args.length > 0
        ? await execa(command, args, { cwd: options.cwd, timeout: options.timeout })
        : await execaCommand(command, { cwd: options.cwd, timeout: options.timeout });
      return { code: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr, ok: true };
    } catch (error) {
      const result = error as { exitCode?: number; stdout?: string; stderr?: string };
      return { code: result.exitCode ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ok: false };
    }
  },
};

async function runReleaseChecks(checks: CustomCheckConfig[], options: { repoRoot: string; packagePaths: string[]; scopePath?: string } = { repoRoot: '/tmp', packagePaths: [] }) {
  return runReleaseChecksCore(checks, { ...options, shell: testShell });
}

// ─── helper scripts ───────────────────────────────────────────────────────────

let scriptsDir: string;

beforeAll(() => {
  scriptsDir = join(tmpdir(), `checks-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'ok-json.js'), `process.stdout.write(JSON.stringify({ok:true}))`);
  writeFileSync(join(scriptsDir, 'success-json.js'), `process.stdout.write(JSON.stringify({success:true}))`);
  writeFileSync(join(scriptsDir, 'status-json.js'), `process.stdout.write(JSON.stringify({status:"ok"}))`);
  writeFileSync(join(scriptsDir, 'fail-json.js'), `process.stdout.write(JSON.stringify({ok:false}))`);
  writeFileSync(join(scriptsDir, 'not-json.js'), `process.stdout.write("not json")`);
  writeFileSync(join(scriptsDir, 'hello.js'), `process.stdout.write("hello world")`);
  writeFileSync(join(scriptsDir, 'test-output.js'), `process.stdout.write("test-output")`);
});

afterAll(() => {
  rmSync(scriptsDir, { recursive: true, force: true });
});

// ─── parser: exitcode (default) ──────────────────────────────────────────────

describe('runReleaseChecks — parser: exitcode', () => {
  it('passes when command exits 0', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'ok', command: 'true', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(true);
  });

  it('fails when command exits non-zero', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'fail', command: 'false', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(false);
  });
});

// ─── parser: json ─────────────────────────────────────────────────────────────

describe('runReleaseChecks — parser: json', () => {
  it('passes when stdout contains { ok: true }', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'json-ok', command: `node ${join(scriptsDir, 'ok-json.js')}`, parser: 'json', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(true);
  });

  it('passes when stdout contains { success: true }', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'json-success', command: `node ${join(scriptsDir, 'success-json.js')}`, parser: 'json', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(true);
  });

  it('passes when stdout contains { status: "ok" }', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'json-status', command: `node ${join(scriptsDir, 'status-json.js')}`, parser: 'json', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(true);
  });

  it('fails when json reports { ok: false }', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'json-fail', command: `node ${join(scriptsDir, 'fail-json.js')}`, parser: 'json', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(false);
  });

  it('fails when stdout is not valid JSON', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'json-invalid', command: `node ${join(scriptsDir, 'not-json.js')}`, parser: 'json', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(false);
  });
});

// ─── parser: function ─────────────────────────────────────────────────────────

describe('runReleaseChecks — parser: function', () => {
  it('uses custom parser function', async () => {
    const checks: CustomCheckConfig[] = [
      {
        id: 'custom',
        command: `node ${join(scriptsDir, 'hello.js')}`,
        parser: (stdout) => stdout.includes('hello'),
        runIn: 'repoRoot',
      },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results[0]?.ok).toBe(true);
  });

  it('custom parser receives stdout, stderr, exitCode', async () => {
    let captured: { stdout: string; stderr: string; exitCode: number } | undefined;
    const checks: CustomCheckConfig[] = [
      {
        id: 'capture',
        command: `node ${join(scriptsDir, 'test-output.js')}`,
        parser: (stdout, stderr, exitCode) => {
          captured = { stdout, stderr, exitCode };
          return true;
        },
        runIn: 'repoRoot',
      },
    ];
    await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(captured?.stdout).toBe('test-output');
    expect(captured?.exitCode).toBe(0);
  });
});

// ─── optional checks ──────────────────────────────────────────────────────────

describe('runReleaseChecks — optional', () => {
  it('continues after optional failure', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'optional-fail', command: 'false', optional: true, runIn: 'repoRoot' },
      { id: 'after', command: 'true', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(true);
  });

  it('runs every later check after a required failure (fail-late)', async () => {
    const checks: CustomCheckConfig[] = [
      { id: 'required-fail', command: 'false', runIn: 'repoRoot' },
      { id: 'still-runs', command: 'true', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecks(checks, { repoRoot: '/tmp', packagePaths: [] });
    expect(results.map(r => r.id)).toEqual(['required-fail', 'still-runs']);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(true);
  });
});

// ─── fail-late: blocking / dependsOn ─────────────────────────────────────────

/** Shell whose result depends on (command args, cwd): fails when cwd is in `failIn[arg]`. */
function scriptedShell(failIn: Record<string, string[]>) {
  const calls: Array<{ arg: string; cwd?: string }> = [];
  return {
    calls,
    shell: {
      async exec(_command: string, args: string[] = [], options: { cwd?: string } = {}) {
        const arg = args[0] ?? '';
        calls.push({ arg, cwd: options.cwd });
        const fail = (failIn[arg] ?? []).includes(options.cwd ?? '');
        return { code: fail ? 1 : 0, stdout: '', stderr: fail ? `${arg} broke in ${options.cwd}` : '', ok: !fail };
      },
    },
  };
}

const PKGS = ['/pkg/a', '/pkg/b', '/pkg/c'];

describe('runReleaseChecks — fail-late with blocking/dependsOn', () => {
  it('runs all checks even when an earlier non-blocking check failed', async () => {
    const { shell, calls } = scriptedShell({ one: ['/repo'] });
    const results = await runReleaseChecksCore([
      { id: 'one', command: 'x', args: ['one'], runIn: 'repoRoot' },
      { id: 'two', command: 'x', args: ['two'], runIn: 'repoRoot' },
      { id: 'three', command: 'x', args: ['three'], runIn: 'repoRoot' },
    ], { repoRoot: '/repo', packagePaths: [], shell });
    expect(results.map(r => [r.id, r.ok])).toEqual([['one', false], ['two', true], ['three', true]]);
    expect(calls.map(c => c.arg)).toEqual(['one', 'two', 'three']);
  });

  it('skips a dependent of a failed blocking check with an explicit reason', async () => {
    const { shell, calls } = scriptedShell({ gate: ['/repo'] });
    const results = await runReleaseChecksCore([
      { id: 'gate', command: 'x', args: ['gate'], runIn: 'repoRoot', blocking: true },
      { id: 'dependent', command: 'x', args: ['dependent'], runIn: 'repoRoot', dependsOn: ['gate'] },
      { id: 'independent', command: 'x', args: ['independent'], runIn: 'repoRoot' },
    ], { repoRoot: '/repo', packagePaths: [], shell });

    expect(results).toHaveLength(3);
    expect(results[1]).toMatchObject({ id: 'dependent', ok: false, skipped: true });
    expect(results[1]?.skipReason).toContain('gate');
    expect(calls.map(c => c.arg)).toEqual(['gate', 'independent']);
    expect(results[2]?.ok).toBe(true);
  });

  it('does not skip dependents when the dependency is not blocking', async () => {
    const { shell, calls } = scriptedShell({ gate: ['/repo'] });
    const results = await runReleaseChecksCore([
      { id: 'gate', command: 'x', args: ['gate'], runIn: 'repoRoot' },
      { id: 'dependent', command: 'x', args: ['dependent'], runIn: 'repoRoot', dependsOn: ['gate'] },
    ], { repoRoot: '/repo', packagePaths: [], shell });
    expect(results[1]?.skipped).toBeUndefined();
    expect(calls.map(c => c.arg)).toEqual(['gate', 'dependent']);
  });

  it('does not skip dependents when the dependency passed', async () => {
    const { shell } = scriptedShell({});
    const results = await runReleaseChecksCore([
      { id: 'gate', command: 'x', args: ['gate'], runIn: 'repoRoot', blocking: true },
      { id: 'dependent', command: 'x', args: ['dependent'], runIn: 'repoRoot', dependsOn: ['gate'] },
    ], { repoRoot: '/repo', packagePaths: [], shell });
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('an optional failing check never blocks, even if marked blocking', async () => {
    const { shell } = scriptedShell({ gate: ['/repo'] });
    const results = await runReleaseChecksCore([
      { id: 'gate', command: 'x', args: ['gate'], runIn: 'repoRoot', blocking: true, optional: true },
      { id: 'dependent', command: 'x', args: ['dependent'], runIn: 'repoRoot', dependsOn: ['gate'] },
    ], { repoRoot: '/repo', packagePaths: [], shell });
    expect(results[0]).toMatchObject({ ok: false, optional: true });
    expect(results[1]?.ok).toBe(true);
    expect(results.every(r => r.ok || r.optional)).toBe(true);
  });

  it('skips a perPackage dependent only for packages whose blocking dependency failed', async () => {
    const { shell, calls } = scriptedShell({ dist: ['/pkg/b'] });
    const results = await runReleaseChecksCore([
      { id: 'dist', command: 'x', args: ['dist'], runIn: 'perPackage', blocking: true },
      { id: 'pack', command: 'x', args: ['pack'], runIn: 'perPackage', dependsOn: ['dist'] },
    ], { repoRoot: '/repo', packagePaths: PKGS, shell });

    const packCalls = calls.filter(c => c.arg === 'pack').map(c => c.cwd).sort();
    expect(packCalls).toEqual(['/pkg/a', '/pkg/c']);
    const pack = results[1]!;
    expect(pack.ok).toBe(false);
    expect(pack.skipped).toBe(true);
    const skipped = pack.packages!.filter(p => p.skipped);
    expect(skipped.map(p => p.path)).toEqual(['/pkg/b']);
    expect(skipped[0]?.skipReason).toContain('dist');
    expect(pack.packages!.filter(p => p.ok).map(p => p.path).sort()).toEqual(['/pkg/a', '/pkg/c']);
  });

  it('skips the whole perPackage dependent when every package failed the dependency', async () => {
    const { shell, calls } = scriptedShell({ dist: PKGS });
    const results = await runReleaseChecksCore([
      { id: 'dist', command: 'x', args: ['dist'], runIn: 'perPackage', blocking: true },
      { id: 'pack', command: 'x', args: ['pack'], runIn: 'perPackage', dependsOn: ['dist'] },
    ], { repoRoot: '/repo', packagePaths: PKGS, shell });
    expect(calls.some(c => c.arg === 'pack')).toBe(false);
    expect(results[1]).toMatchObject({ skipped: true, ok: false });
  });

  it('overall exit semantics: fails if any non-optional check failed or was skipped', async () => {
    const { shell } = scriptedShell({ gate: ['/repo'] });
    const results = await runReleaseChecksCore([
      { id: 'gate', command: 'x', args: ['gate'], runIn: 'repoRoot', blocking: true },
      { id: 'dependent', command: 'x', args: ['dependent'], runIn: 'repoRoot', dependsOn: ['gate'] },
    ], { repoRoot: '/repo', packagePaths: [], shell });
    expect(results.every(r => r.ok || r.optional)).toBe(false);
  });
});

// ─── governed-timeout diagnostics ─────────────────────────────────────────────
// Regression: a governor-enforced timeout kill (node-backend.ts) rejects with
// a GovernedProcessError carrying whatever stdout/stderr the killed process
// had buffered as `details.result`. Before this fix, runForPath's catch block
// only kept `error.message` on a second (post-retry) timeout — the captured
// partial output was silently dropped, leaving a debugging agent with nothing
// but "Process terminated: timeout" for a check that ran for over a minute.

function makeGovernedTimeoutError(partial: { stdout?: string; stderr?: string; code?: number }) {
  const error = new Error('Process terminated: timeout') as Error & {
    code: string;
    details: { result: typeof partial };
  };
  error.name = 'GovernedProcessError';
  error.code = 'PROCESS_TIMEOUT';
  error.details = { result: partial };
  return error;
}

describe('runReleaseChecks — governed timeout diagnostics', () => {
  it('surfaces partial stdout/stderr captured before the kill, after retry is exhausted', async () => {
    let calls = 0;
    const timeoutShell = {
      async exec() {
        calls++;
        throw makeGovernedTimeoutError({
          stdout: 'installed 40/62 packages\n',
          stderr: 'npm warn deprecated foo@1.0.0\n',
          code: undefined,
        });
      },
    };

    const checks: CustomCheckConfig[] = [
      { id: 'pack-install', command: 'true', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecksCore(checks, {
      repoRoot: '/tmp',
      packagePaths: [],
      shell: timeoutShell,
    });

    // Retried once (attempt 1 timeout → attempt 2), then gave up.
    expect(calls).toBe(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.details?.stdout).toContain('installed 40/62 packages');
    expect(results[0]?.details?.stderr).toContain('npm warn deprecated');
    expect(results[0]?.details?.error).toMatch(/timeout/i);
  });

  it('does not fabricate stdout/stderr fields for a non-governed rejection', async () => {
    const plainErrorShell = {
      async exec() {
        throw new Error('ENOENT: command not found');
      },
    };

    const checks: CustomCheckConfig[] = [
      { id: 'missing-cmd', command: 'true', runIn: 'repoRoot' },
    ];
    const results = await runReleaseChecksCore(checks, {
      repoRoot: '/tmp',
      packagePaths: [],
      shell: plainErrorShell,
    });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.details?.stdout).toBeUndefined();
    expect(results[0]?.details?.stderr).toBeUndefined();
    expect(results[0]?.details?.error).toContain('ENOENT');
  });
});
