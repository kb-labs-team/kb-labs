import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { nativeInstallCommands } from '../../e2e/journey/native-macos-install.mjs';
import { discoverModules } from './go-module-suite.mjs';
import { runExternalCheck } from '../checks/lib/run-external-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
const suite = path.join(root, 'scripts/ci/go-module-suite.mjs');

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// case: S-261.1, S-261.9
test('registry-driven suite runs discovered packages with clean HOME and TMPDIR variants', () => {
  const fixture = mkdtempSync(path.join('/tmp', 'go-module-suite-'));
  temporaryDirectories.push(fixture);
  const modulesRoot = path.join(fixture, 'modules');
  const moduleOne = path.join(modulesRoot, 'first');
  const moduleTwo = path.join(modulesRoot, 'second');
  mkdirSync(path.join(moduleOne, 'e2e'), { recursive: true });
  mkdirSync(moduleTwo, { recursive: true });
  writeFileSync(path.join(moduleOne, 'go.mod'), 'module fixture/first\n\ngo 1.22\n');
  writeFileSync(path.join(moduleTwo, 'go.mod'), 'module fixture/second\n\ngo 1.22\n');
  const registry = path.join(fixture, 'devkit.yaml');
  writeFileSync(registry, `workspace:\n  categories:\n    go-binary:\n      language: go\n      match:\n        - "modules/first"\n    internal-tool:\n      language: go\n      match:\n        - "modules/second"\n`);
  const invocations = path.join(fixture, 'go-invocations.jsonl');
  const fakeGo = path.join(fixture, 'go');
  writeFileSync(fakeGo, `#!/bin/sh\nprintf '%s\\n' "{\\"args\\":\\"$*\\",\\"cwd\\":\\"$PWD\\",\\"goos\\":\\"$GOOS\\",\\"home\\":\\"$HOME\\",\\"tmpdir\\":\\"$TMPDIR\\",\\"platform_root\\":\\"$KB_PLATFORM_ROOT\\",\\"kb_home\\":\\"$KB_HOME\\",\\"net_offset\\":\\"$KB_NET_OFFSET\\",\\"goflags\\":\\"$GOFLAGS\\",\\"deadline_scale\\":\\"$KB_TEST_DEADLINE_SCALE\\"}" >> "$GO_SUITE_LOG"\nif [ "$1" = list ]; then printf '%s\\n' 'fixture/first' 'fixture/first/e2e' 'fixture/second'; fi\n`);
  const chmod = spawnSync('chmod', ['+x', fakeGo]);
  assert.equal(chmod.status, 0);

  const result = spawnSync(process.execPath, [suite, '--registry', registry, '--root', fixture, '--go', fakeGo], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: fixture,
      GO_SUITE_LOG: invocations,
      KB_PLATFORM_ROOT: '/must/be/unset',
      KB_HOME: '/must/be/unset',
      KB_NET_OFFSET: '99',
      GOFLAGS: '-tags=contaminated',
      KB_TEST_DEADLINE_SCALE: '1.5',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = readFileSync(invocations, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const tests = calls.filter((call) => call.args.startsWith('test '));
  const linuxVets = calls.filter((call) => call.args.startsWith('vet '));
  assert.equal(linuxVets.length, 2, 'each discovered module gets one Linux test-file vet pass');
  assert.ok(linuxVets.every((call) => call.goos === 'linux'));
  assert.ok(linuxVets.every((call) => !call.args.includes('/e2e')));
  assert.equal(tests.length, 4, 'two discovered modules run in each of two TMPDIR variants');
  assert.ok(calls.some((call) => call.args.includes('fixture/first/e2e')) === false, 'e2e packages are excluded');
  assert.equal(new Set(tests.map((call) => call.tmpdir)).size, 4, 'every module run has a fresh TMPDIR root');
  assert.deepEqual(tests.map((call) => path.dirname(call.tmpdir)), ['/tmp', '/tmp', fixture, fixture]);
  assert.notEqual(tests[0].tmpdir, tests[1].tmpdir, 'module runs in variant one do not share temp state');
  assert.notEqual(tests[2].tmpdir, tests[3].tmpdir, 'module runs in variant two do not share temp state');
  for (const call of calls) {
    assert.ok(call.home.startsWith(call.tmpdir));
    assert.equal(call.platform_root, '');
    assert.equal(call.kb_home, '');
    assert.equal(call.net_offset, '');
    assert.equal(call.goflags, '');
    assert.equal(call.deadline_scale, '1.5');
  }
  for (const call of tests) {
    assert.ok(call.args.includes('fixture/first') || call.args.includes('fixture/second'));
    assert.ok(!call.args.includes('./...'), 'go test receives the discovered package set');
  }
  assert.match(result.stdout, /modules\/first.*PASS/s);
  assert.match(result.stdout, /modules\/second.*PASS/s);
});

// case: S-261.1
test('suite refuses a TMPDIR root without Unix socket path capacity before running packages', () => {
  const fixture = temporaryDirectory('go-module-suite-long-tmp-');
  const longDefaultTemp = path.join(fixture, 'x'.repeat(180));
  mkdirSync(longDefaultTemp);
  const modulesRoot = path.join(fixture, 'modules');
  const moduleDir = path.join(modulesRoot, 'first');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(path.join(moduleDir, 'go.mod'), 'module fixture/first\n\ngo 1.22\n');
  const registry = path.join(fixture, 'devkit.yaml');
  writeFileSync(registry, `workspace:\n  categories:\n    go-binary:\n      language: go\n      match:\n        - "modules/*"\n`);
  const invocations = path.join(fixture, 'go-invocations.jsonl');
  const fakeGo = path.join(fixture, 'go');
  writeFileSync(fakeGo, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GO_SUITE_LOG"\nif [ "$1" = list ]; then printf '%s\\n' 'fixture/first'; fi\n`);
  const chmod = spawnSync('chmod', ['+x', fakeGo]);
  assert.equal(chmod.status, 0);

  const result = spawnSync(process.execPath, [suite, '--registry', registry, '--root', fixture, '--go', fakeGo], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: longDefaultTemp, GO_SUITE_LOG: invocations },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /GO_SUITE_TMPDIR_SOCKET_PATH_TOO_LONG/);
  assert.match(result.stderr, /variant two/);
  assert.equal(
    result.stderr.trim().split('. Rerun with: ').at(-1),
    `TMPDIR='/tmp' '${process.execPath}' '${suite}' '--registry' '${registry}' '--root' '${fixture}' '--go' '${fakeGo}'`,
  );
  assert.equal(existsSync(invocations), false, 'preflight refusal happens before go list or go test');

  const gate = path.join(root, 'scripts/ci/go-module-suite-gate.mjs');
  const registeredCheck = runExternalCheck(gate, [], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: longDefaultTemp, GO_SUITE_LOG: invocations, KB_DEVKIT_CHECK_NAME: 'go-module-suite' },
  });
  assert.equal(registeredCheck.exitCode, 1, registeredCheck.stderr || registeredCheck.stdout);
  const issue = registeredCheck.result.issues[0];
  assert.equal(issue.fix, 'Rerun with: kb-devkit check --only go-module-suite');
  assert.ok(issue.message.endsWith("Rerun with: TMPDIR='/tmp' kb-devkit check --only go-module-suite"));
  assert.equal(existsSync(invocations), false, 'registered preflight refusal happens before go list or go test');
});

// case: S-261.1
test('registry discovery fails when it is empty or a registered pattern has no modules', () => {
  const fixture = temporaryDirectory('go-module-suite-empty-');
  const modules = path.join(fixture, 'modules');
  mkdirSync(modules, { recursive: true });
  const registry = path.join(fixture, 'devkit.yaml');
  writeFileSync(registry, 'workspace:\n  categories:\n    go-binary:\n      language: go\n      match: []\n');
  const empty = spawnSync(process.execPath, [suite, '--registry', registry, '--root', fixture], { cwd: root, encoding: 'utf8' });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /match array|empty set/);

  writeFileSync(registry, 'workspace:\n  categories:\n    go-binary:\n      language: go\n      match:\n        - "modules/*"\n');
  const unmatched = spawnSync(process.execPath, [suite, '--registry', registry, '--root', fixture], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unmatched.status, 0);
  assert.match(unmatched.stderr, /matched no modules/);
});

// case: S-277.1
test('candidate Go module suite excludes internal-tool modules from the devkit category declaration', () => {
  const devkit = load(readFileSync(path.join(root, 'devkit.yaml'), 'utf8'));
  assert.equal(devkit.workspace.categories['internal-tool'].releaseLane, 'internal-tool');
  const modules = discoverModules(root, path.join(root, 'devkit.yaml'));
  assert.ok(!modules.includes('tools/kb-runner'));
  assert.ok(modules.includes('tools/kb-create'));
  assert.ok(modules.includes('tools/clikit'));
});

// case: S-277.1
test('candidate Go suite never invokes a failing internal-tool Go test', () => {
  const fixture = temporaryDirectory('go-suite-release-lane-');
  const gatingModule = path.join(fixture, 'modules/gating');
  const internalModule = path.join(fixture, 'modules/internal');
  mkdirSync(gatingModule, { recursive: true });
  mkdirSync(internalModule, { recursive: true });
  writeFileSync(path.join(gatingModule, 'go.mod'), 'module fixture/gating\n\ngo 1.22\n');
  writeFileSync(path.join(internalModule, 'go.mod'), 'module fixture/internal\n\ngo 1.22\n');
  const registry = path.join(fixture, 'devkit.yaml');
  writeFileSync(registry, [
    'workspace:',
    '  categories:',
    '    shipped-go:',
    '      language: go',
    '      match: [modules/gating]',
    '    private-go:',
    '      language: go',
    '      match: [modules/internal]',
    '      releaseLane: internal-tool',
    '',
  ].join('\n'));
  const calls = path.join(fixture, 'go-calls.log');
  const fakeGo = path.join(fixture, 'go');
  writeFileSync(fakeGo, [
    '#!/bin/sh',
    'printf "%s %s\\n" "$PWD" "$*" >> "$GO_SUITE_LOG"',
    'if [ "$1" = list ]; then printf "%s\\n" fixture/gating; exit 0; fi',
    'if [ "$PWD" = "$GO_SUITE_INTERNAL_DIR" ] && [ "$1" = test ]; then echo runner test failed; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'));
  const chmod = spawnSync('chmod', ['+x', fakeGo]);
  assert.equal(chmod.status, 0);

  const result = spawnSync(process.execPath, [suite, '--registry', registry, '--root', fixture, '--go', fakeGo], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GO_SUITE_LOG: calls,
      GO_SUITE_INTERNAL_DIR: internalModule,
      GOMODCACHE: path.join(fixture, 'module-cache'),
      GOCACHE: path.join(fixture, 'build-cache'),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const invocations = readFileSync(calls, 'utf8');
  assert.match(invocations, /modules\/gating/);
  assert.doesNotMatch(invocations, /modules\/internal/);
});

// case: S-261.1
test('local Go suite workspace check derives modules from the devkit go-binary registry', () => {
  const devkit = load(readFileSync(path.join(root, 'devkit.yaml'), 'utf8'));
  const check = devkit.custom_checks.find((item) => item.name === 'go-module-suite');
  assert.equal(check.scope, 'workspace');
  assert.equal(check.categories, undefined);
  assert.equal(check.on.includes('check'), true);
  assert.match(check.run, /scripts\/ci\/go-module-suite-gate\.mjs/);
  assert.match(readFileSync(path.join(root, 'scripts/ci/go-module-suite-gate.mjs'), 'utf8'), /go-module-suite\.mjs/);
  assert.equal(existsSync(path.join(root, '.github/workflows/go-module-tests.yml')), false);
});

// case: S-261.3
test('nightly journey workflow syncs the scoreboard through the GitHub issue owner', () => {
  const workflow = load(readFileSync(path.join(root, '.github/workflows/nightly-user-journey.yml'), 'utf8'));
  assert.equal(workflow.permissions.issues, 'write');
  const report = workflow.jobs.report;
  assert.equal(report.permissions.issues, 'write');
  assert.ok(report.steps.some((step) => step.name === 'Aggregate matrix, compare yesterday, and sync issues'));
  const syncStep = report.steps.find((step) => step.name === 'Aggregate matrix, compare yesterday, and sync issues');
  assert.ok(syncStep.env.GITHUB_TOKEN);
  assert.equal(syncStep.env.NIGHTLY_STATUS_ISSUE, '0');
  assert.ok(report.steps.some((step) => step.name === 'Add detailed report to job summary'));
  assert.ok(report.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')
    && step.with?.name === 'nightly-user-journey-${{ github.run_id }}'));
});

// case: S-261.2
test('reusable installer workflow runs a native macOS install from the candidate artifact', () => {
  const workflow = load(readFileSync(path.join(root, '.github/workflows/reusable-installer-journey.yml'), 'utf8'));
  assert.deepEqual(workflow.jobs.journey.strategy.matrix.os, ['ubuntu-latest']);
  const native = workflow.jobs.native_macos;
  assert.equal(native['runs-on'], 'macos-latest');
  const nodeSetup = native.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(nodeSetup.with['node-version-file'], 'package.json');
  const coverage = workflow.jobs.coverage;
  const coverageNodeSetup = coverage.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(coverageNodeSetup.with['node-version-file'], 'package.json');
  const downloads = native.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(downloads.with.name, 'installer-journey-candidate');
  const setup = native.steps.find((step) => step.name === 'Install candidate natively and smoke the installed CLI');
  assert.equal(setup.run, 'e2e/journey/native-macos-smoke.sh');
  assert.doesNotThrow(() => accessSync(path.join(root, setup.run), constants.X_OK));
  assert.deepEqual(native.steps.filter((step) => step.run).map((step) => step.run), ['e2e/journey/native-macos-smoke.sh']);
  assert.ok(!native.steps.some((step) => step.uses?.startsWith('docker/')));
  assert.equal(native['timeout-minutes'] > 0, true);
});

// case: S-261.2
test('native macOS smoke entry installs the candidate and runs the installed CLI', () => {
  const commands = nativeInstallCommands({ workspace: '/workspace', tempRoot: '/tmp/native', platformRoot: '/tmp/platform', registryUrl: 'http://127.0.0.1:49183' });
  assert.deepEqual(commands.map(({ command, args, cwd }) => [command, args, cwd]), [
    ['make', ['build', 'BINARY=/tmp/native/kb-create'], '/workspace/tools/kb-create'],
    ['/tmp/native/kb-create', [
      'install', '--json', '--index', '/workspace/.journey/release/journey-candidate/release-index.json',
      '--platform-root', '/tmp/platform', '--project-root', '/workspace', '--scenario', 'explore',
      '--scenario-answers', '{"access.mode":"local"}', '--registry', 'http://127.0.0.1:49183',
    ], '/workspace'],
    ['/tmp/platform/node_modules/.bin/kb', ['--version'], '/workspace'],
    ['/tmp/platform/node_modules/.bin/kb', ['doctor', '--json'], '/workspace'],
    ['/tmp/platform/node_modules/.bin/kb', ['project', 'add', '/workspace', '--json'], '/workspace'],
    ['/tmp/platform/node_modules/.bin/kb', ['qa', 'cases', 'list', '--json'], '/workspace'],
  ]);
});

// case: S-261.2
test('shared candidate services start, publish, and clean up the native origin and registry', () => {
  const fixture = temporaryDirectory('journey-candidate-services-');
  const bin = path.join(fixture, 'bin');
  mkdirSync(bin);
  const pids = path.join(fixture, 'service-pids');
  const publish = path.join(fixture, 'publish-call');
  for (const command of ['python3']) {
    writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$$" >> "$SERVICE_PIDS"\nexec sleep 3600\n', { mode: 0o755 });
  }
  writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n'
    + 'case "$*" in\n'
    + "  *'compose version') exit 0 ;;\n"
    + "  *' run --rm --no-deps --entrypoint sh verdaccio -s -- /verdaccio/storage') cat >/dev/null; exit 0 ;;\n"
    + "  *' up -d --wait verdaccio') exit 0 ;;\n"
    + "  *' port verdaccio 4873') printf '127.0.0.1:49183\\n'; exit 0 ;;\n"
    + "  *' stop verdaccio') exit 0 ;;\n"
    + 'esac\nexit 97\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'sh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PUBLISH_CALL"\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-e', '-c', 'source "$1"; source "$2"; journey_compose_init "$PWD"; trap "journey_stop_host_services" EXIT; journey_start_host_services; journey_stop_host_services; trap - EXIT', 'candidate-services-test', path.join(root, 'e2e/compose-owner.sh'), path.join(root, 'e2e/journey/candidate-services.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: fixture, SERVICE_PIDS: pids, PUBLISH_CALL: publish },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(readFileSync(publish, 'utf8'), /e2e\/publisher\/publish\.sh/);
  assert.equal(readdirSync(fixture).some((entry) => entry.startsWith('kb-journey-host-services.')), false);
  for (const pid of readFileSync(pids, 'utf8').trim().split('\n')) {
    assert.notEqual(spawnSync('kill', ['-0', pid]).status, 0, `service process ${pid} must be stopped`);
  }
});
