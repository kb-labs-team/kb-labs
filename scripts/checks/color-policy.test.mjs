import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { colorPolicy } from '../../core/plugin-contracts/src/color-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const generator = path.join(root, 'tools/clikit/ui/generate-color-policy.mjs');
const installerPaths = [
  'tools/kb-create/install.sh',
  'tools/kb-dev/install.sh',
  'tools/kb-deploy/install.sh',
  'tools/kb-devkit/install.sh',
  'tools/kb-monitor/install.sh',
];
const behaviorCases = colorPolicy.cases.filter(({ name }) => [
  'empty NO_COLOR terminal', 'forced color pipe', 'TERM dumb terminal',
].includes(name));

// case: S-278.1, S-278.2, S-278.3
test('all shipped installers use the generated color policy through pipes and PTYs', () => {
  const pathRoot = mkdtempSync(path.join(os.tmpdir(), 'color-policy-path-'));
  try {
    symlinkSync('/bin/date', path.join(pathRoot, 'date'));
    for (const installer of installerPaths) {
      for (const testCase of behaviorCases) {
        const env = { ...process.env, PATH: pathRoot, NO_COLOR: testCase.noColor, FORCE_COLOR: testCase.forceColor, TERM: testCase.term };
        const result = invokeInstaller(path.join(root, installer), testCase, env, pathRoot);
        assert.equal(result.status, 1, `${installer} ${testCase.name}: ${result.stderr}${result.stdout}`);
        const colored = /\u001b\[/.test(`${result.stdout}${result.stderr}`);
        assert.equal(colored, testCase.want, `${installer} ${testCase.name}`);
      }
    }
  } finally {
    rmSync(pathRoot, { recursive: true, force: true });
  }
});

test('color policy generator --check rejects a hand-edited generated consumer', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'color-policy-check-'));
  try {
    for (const relative of [
      'tools/clikit/ui/color_policy_gen.go',
      'templates/go-binary/cmd/color_policy_gen.go',
      'tools/kb-dev/cmd/color_policy_cases_test.go',
      ...installerPaths,
    ]) {
      const target = path.join(temporaryRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(root, relative), target, { recursive: true });
    }
    const edited = path.join(temporaryRoot, 'tools/clikit/ui/color_policy_gen.go');
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}// hand edit\n`);
    const result = spawnSync(process.execPath, [generator, '--check', '--root', temporaryRoot], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /color_policy_gen\.go is stale/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function invokeInstaller(installer, testCase, env, installerPath) {
  if (!testCase.tty) return spawnSync('/bin/sh', [installer], { cwd: root, env, encoding: 'utf8' });
  const ptyDriver = `import os, pty, subprocess, sys
master, slave = pty.openpty()
child_env = os.environ.copy()
child_env["PATH"] = sys.argv[2]
process = subprocess.Popen(["/bin/sh", sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, env=child_env)
os.close(slave)
chunks = []
while True:
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    chunks.append(chunk)
os.close(master)
sys.stdout.buffer.write(b"".join(chunks))
sys.exit(process.wait())`;
  return spawnSync('python3', ['-c', ptyDriver, installer, installerPath], { cwd: root, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' });
}
