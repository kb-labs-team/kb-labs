import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCandidateBundle } from '../../src/shared/candidate-bundle.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function runChild(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) { rejectChild(new Error('Child did not start')); return; }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) rejectChild(error);
      }
    }, 30000);
    child.once('error', error => { clearTimeout(timer); rejectChild(error); });
    child.once('close', status => {
      clearTimeout(timer);
      if (timedOut) rejectChild(new Error(`Child timed out: ${command}`));
      else resolveChild({ status, stdout, stderr });
    });
  });
}

// case: S-284.16
it('delivers a transported candidate through the built CLI in dry-run mode', async () => {
  root = mkdtempSync(join(tmpdir(), 'kb-candidate-delivery-'));
  const artifacts = join(root, 'artifacts');
  const source = join(root, 'package');
  const binaries = join(root, 'binaries');
  mkdirSync(artifacts);
  mkdirSync(source);
  mkdirSync(binaries);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@kb-labs/candidate-fixture', version: '1.0.0' }));
  writeFileSync(join(binaries, 'executable'), 'binary');
  chmodSync(join(binaries, 'executable'), 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, npm_config_cache: join(root, 'npm-cache') };
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  delete env.KB_HOME;
  delete env.KB_PLATFORM_ROOT;
  delete env.KB_NET_OFFSET;
  const pack = await runChild('npm', ['pack', '--json', '--pack-destination', artifacts], source, env);
  expect(pack.status, pack.stderr).toBe(0);
  const tarball = JSON.parse(pack.stdout)[0].filename as string;
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify([{
    name: '@kb-labs/candidate-fixture', version: '1.0.0', tarball,
    sha256: createHash('sha256').update(readFileSync(join(artifacts, tarball))).digest('hex'),
  }]));
  const releaseIndex = join(root, 'release-index.json');
  writeFileSync(releaseIndex, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const bundle = join(root, 'bundle');
  const commit = '1234567890123456789012345678901234567890';
  const provenance = createCandidateBundle({
    candidateId: 'test-candidate', commit, flow: 'platform', version: '1.0.0', channel: 'canary',
    gate: { policy: 'none', result: 'skipped' }, workflowRunId: 'test-run',
    artifactsDir: artifacts, outputDir: bundle, releaseIndexPath: releaseIndex, binariesDir: binaries,
  });
  const normalize = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) normalize(path);
      else chmodSync(path, 0o644);
    }
  };
  normalize(bundle);
  const workspace = resolve('../..');
  const result = await runChild(process.execPath, [
    join(workspace, 'cli/bin/dist/bin.js'), 'release', 'artifact', 'publish',
    '--flow', 'platform', '--bundle-dir', bundle, '--expected-digest', provenance.bundleDigest,
    '--candidate-id', 'test-candidate', '--commit', commit, '--version', '1.0.0',
    '--target', 'local', '--json', '--dry-run',
  ], workspace, env);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, data: { success: true } });
  expect(statSync(join(bundle, 'binaries', 'executable')).mode & 0o777).toBe(0o700);
}, 65000);
