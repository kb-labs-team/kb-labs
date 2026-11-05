import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';

const scriptPath = fileURLToPath(new URL('./release-build-preflight.sh', import.meta.url));
const candidateWorkflowPath = fileURLToPath(new URL('../.github/workflows/release-build-candidate.yml', import.meta.url));
const candidateActionPath = fileURLToPath(new URL('../.github/actions/release-build-preflight/action.yml', import.meta.url));

test('candidate job expands the shared build once and leaves only hosted-only steps afterward', () => {
  const workflow = loadYaml(readFileSync(candidateWorkflowPath, 'utf8'));
  const steps = workflow.jobs.build.steps;
  const buildActionIndexes = steps.flatMap((step, index) => step.uses === './.github/actions/release-build-preflight' ? [index] : []);
  assert.equal(buildActionIndexes.length, 1, 'candidate job must invoke the shared release-build action exactly once');

  const action = loadYaml(readFileSync(candidateActionPath, 'utf8'));
  const preflightEntrypoints = action.runs.steps.filter(step => step.run === 'bash scripts/release-build-preflight.sh "$FLOW" "$CHANNEL" "$COMMIT_SHA" "$MODE" "$EXPECTED_VERSION"');
  assert.equal(preflightEntrypoints.length, 1, 'shared action must execute the release preflight exactly once');
  const candidateBuild = steps[buildActionIndexes[0]];
  assert.equal(candidateBuild.with['candidate-id'], '${{ inputs.candidate_id }}');
  assert.equal(candidateBuild.with['run-id'], '${{ github.run_id }}');
  assert.equal(candidateBuild.with['gate-policy'], '${{ needs.resolve-gate-policy.outputs.policy }}');
  assert.equal(candidateBuild.with['gate-result'], "${{ needs.journey-gate.result == 'success' && 'passed' || 'skipped' }}");
  assert.equal(candidateBuild.with['gate-run-id'], "${{ needs.journey-gate.result == 'success' && github.run_id || '' }}");
  assert.deepEqual(
    Object.fromEntries(['CANDIDATE_ID', 'RUN_ID', 'GATE_POLICY', 'GATE_RESULT', 'GATE_RUN_ID'].map(name => [name, preflightEntrypoints[0].env[name]])),
    {
      CANDIDATE_ID: "${{ inputs['candidate-id'] }}",
      RUN_ID: "${{ inputs['run-id'] }}",
      GATE_POLICY: "${{ inputs['gate-policy'] }}",
      GATE_RESULT: "${{ inputs['gate-result'] }}",
      GATE_RUN_ID: "${{ inputs['gate-run-id'] }}",
    },
  );

  const postActionSteps = steps.slice(buildActionIndexes[0] + 1);
  for (const step of postActionSteps) {
    const classification = step.env?.RELEASE_PREFLIGHT_COVERAGE;
    assert.ok(classification, `${step.name} must declare RELEASE_PREFLIGHT_COVERAGE`);
    assert.equal(classification, 'hosted-only', `${step.name} has an unknown coverage classification`);
    assert.ok(step.env?.RELEASE_PREFLIGHT_HOSTED_ONLY_REASON?.trim(), `${step.name} must explain its hosted-only requirement`);
  }
});

test('preflight reports a final CLI command failure with its exact command and status', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kb-release-preflight-'));
  try {
    const binDir = path.join(root, 'bin');
    const devkitDir = path.join(root, 'tools', 'kb-devkit');
    const scriptsDir = path.join(root, 'scripts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(devkitDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(path.join(root, '.kb'), { recursive: true });
    writeFileSync(path.join(root, '.kb', 'marketplace.lock'), JSON.stringify({ adapters: {} }));
    writeFileSync(path.join(root, 'scripts-release-build-preflight.sh'), readFileSync(scriptPath));
    writeFileSync(path.join(scriptsDir, 'release-candidate-post-build.sh'), readFileSync(new URL('./release-candidate-post-build.sh', import.meta.url)));

    const node = path.join(binDir, 'node');
    writeFileSync(node, `#!/usr/bin/env bash
if [[ "$*" == *"release build run"* ]]; then
  printf 'forced release stdout tail\\n'
  printf 'forced release stderr tail\\n' >&2
  exit 1
fi
if [[ "$*" == *"release plan"* ]]; then printf '{"ok":true}\\n'; fi
exit 0
`);
    chmodSync(node, 0o755);

    const devkit = path.join(devkitDir, 'kb-devkit');
    writeFileSync(devkit, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(devkit, 0o755);

    const diagnosticsDir = path.join(root, 'diagnostics');
    const result = spawnSync('bash', [path.join(root, 'scripts-release-build-preflight.sh'), 'platform', 'canary', '0123456789abcdef0123456789abcdef01234567', 'preflight'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: root, CI: 'true', KBLABS_RELEASE_DIAGNOSTICS_DIR: diagnosticsDir },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Release preflight command failed \(exit 1\): node \.\/cli\/bin\/dist\/bin\.js release build run --flow platform --json/);
    assert.match(result.stderr, /forced release stdout tail/);
    assert.match(result.stderr, /forced release stderr tail/);
    assert.equal(readFileSync(path.join(diagnosticsDir, 'step-005-stdout.log'), 'utf8'), 'forced release stdout tail\n');
    assert.equal(readFileSync(path.join(diagnosticsDir, 'step-005-stderr.log'), 'utf8'), 'forced release stderr tail\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight stages npm artifacts after the release build', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kb-release-preflight-'));
  try {
    const binDir = path.join(root, 'bin');
    const devkitDir = path.join(root, 'tools', 'kb-devkit');
    const scriptsDir = path.join(root, 'scripts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(devkitDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(path.join(root, '.kb'), { recursive: true });
    writeFileSync(path.join(root, '.kb', 'marketplace.lock'), JSON.stringify({ adapters: {} }));
    writeFileSync(path.join(root, 'scripts-release-build-preflight.sh'), readFileSync(scriptPath));
    writeFileSync(path.join(scriptsDir, 'release-candidate-post-build.sh'), readFileSync(new URL('./release-candidate-post-build.sh', import.meta.url)));

    const node = path.join(binDir, 'node');
    const nodeArgsPath = path.join(root, 'node-args.txt');
    const orderPath = path.join(root, 'command-order.txt');
    const bundleMetadataPath = path.join(root, 'bundle-metadata.txt');
    const goreleaserTagPath = path.join(root, 'goreleaser-tag.txt');
    writeFileSync(node, `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$*" >> '${nodeArgsPath}'
if [[ -n "$RELEASE_PREFLIGHT_ORDER_FILE" ]]; then printf 'node %s\\n' "$*" >> "$RELEASE_PREFLIGHT_ORDER_FILE"; fi
if [[ "$args" == *"release plan"* ]]; then printf '{"ok":true}\\n'; fi
if [[ "$args" == *"release artifact create"* ]]; then mkdir -p .kb/release/artifacts; printf '[]\\n' > .kb/release/artifacts/manifest.json; fi
if [[ "$args" == *"resolve-candidate-gate.mjs"* ]]; then printf 'required=false\\npolicy=none\\ntarget=local\\n' > "$GITHUB_OUTPUT"; fi
if [[ "$args" == *"platform-release-config.mjs"* ]]; then printf '{"platformMembers":[],"platformRequires":[],"adapters":{},"adapterOptions":{}}'; fi
if [[ "$args" == *"d.platformMembers.join"* || "$args" == *"d.platformRequires.join"* ]]; then printf ''; fi
if [[ "$args" == *"JSON.stringify(d.adapters)"* || "$args" == *"JSON.stringify(d.adapterOptions)"* ]]; then printf '{}'; fi
if [[ "$args" == *"prepare-release-index.mjs"* ]]; then mkdir -p "$(dirname "$RELEASE_INDEX_PATH")"; printf '{"platforms":[{"id":"platform","version":"%s"}]}\\n' "$EXPECTED_VERSION" > "$RELEASE_INDEX_PATH"; fi
if [[ "$args" == *"process.env.RELEASE_INDEX_PATH"* ]]; then printf '%s' "$EXPECTED_VERSION"; fi
if [[ "$args" == *"create-candidate-bundle.mjs"* ]]; then printf '%s|%s|%s|%s|%s|%s|%s\\n' "$CANDIDATE_ID" "$COMMIT_SHA" "$VERSION" "$GATE_POLICY" "$GATE_RESULT" "$GATE_RUN_ID" "$RUN_ID" > '${bundleMetadataPath}'; printf 'bundle assembled\\n'; fi
if [[ "$1" == -p ]]; then printf '2.0.0-preflight\\n'; fi
exit 0
`);
    chmodSync(node, 0o755);

    const devkit = path.join(devkitDir, 'kb-devkit');
    writeFileSync(devkit, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(devkit, 0o755);

    const go = path.join(binDir, 'go');
    const goArgsPath = path.join(root, 'go-args.txt');
    writeFileSync(go, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${goArgsPath}'\nprintf '[]\\n'\n`);
    chmodSync(go, 0o755);

    const goreleaser = path.join(binDir, 'goreleaser');
    const goreleaserArgsPath = path.join(root, 'goreleaser-args.txt');
    writeFileSync(goreleaser, `#!/usr/bin/env bash
printf '%s\\n' "$*" > '${goreleaserArgsPath}'
printf '%s\\n' "$GORELEASER_CURRENT_TAG" > '${goreleaserTagPath}'
printf 'goreleaser %s\\n' "$*" >> "$RELEASE_PREFLIGHT_ORDER_FILE"
`);
    chmodSync(goreleaser, 0o755);

    const result = spawnSync('bash', [path.join(root, 'scripts-release-build-preflight.sh'), 'platform', 'canary', '0123456789abcdef0123456789abcdef01234567', 'candidate', '2.0.0-canary.012345678'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: root,
        CI: 'true',
        GITHUB_REPOSITORY: 'example/kb-labs',
        CANDIDATE_ID: 'candidate-012345678',
        RUN_ID: 'test-run-1',
        GATE_POLICY: 'required',
        GATE_RESULT: 'passed',
        GATE_RUN_ID: 'test-gate-run-1',
        RELEASE_PREFLIGHT_ORDER_FILE: orderPath,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(goreleaserArgsPath, 'utf8').trim(), 'release --snapshot --clean --skip=publish');
    assert.equal(readFileSync(goreleaserTagPath, 'utf8').trim(), 'v2.0.0-canary.012345678-binaries');
    const nodeCommands = readFileSync(nodeArgsPath, 'utf8');
    assert.match(nodeCommands, /\.\/cli\/bin\/dist\/bin\.js release artifact create --flow platform --out-dir \.kb\/release\/artifacts --json/);
    const snapshotPosition = nodeCommands.indexOf('tools/kb-create/scripts/prepare-binary-manifest.mjs');
    const regressionPosition = nodeCommands.indexOf('--test tools/kb-create/scripts/prepare-binary-manifest.preflight.mjs');
    assert.ok(snapshotPosition >= 0, nodeCommands);
    assert.ok(regressionPosition > snapshotPosition, nodeCommands);
    const releaseDist = process.env.KBLABS_RELEASE_DIST ?? 'dist';
    assert.ok(nodeCommands.includes(`--artifacts ${releaseDist}/artifacts.json --checksums ${releaseDist}/checksums.txt`), nodeCommands);
    assert.match(nodeCommands, /process\.env\.RELEASE_INDEX_PATH/);
    assert.deepEqual(readFileSync(goArgsPath, 'utf8').trim().split(' '), [
      '-C', 'tools/kb-create', 'run', './v2/cmd/kb-create-release-index', 'provenance',
      path.join(root, '.kb/release/artifacts'), '0123456789abcdef0123456789abcdef01234567',
    ]);
    const commandOrder = readFileSync(orderPath, 'utf8');
    const goreleaserPosition = commandOrder.indexOf('goreleaser release --snapshot --clean --skip=publish');
    const manifestPosition = commandOrder.indexOf('node tools/kb-create/scripts/prepare-binary-manifest.mjs');
    const regressionOrderPosition = commandOrder.indexOf('node --test tools/kb-create/scripts/prepare-binary-manifest.preflight.mjs');
    assert.ok(goreleaserPosition >= 0 && manifestPosition > goreleaserPosition, commandOrder);
    assert.ok(regressionOrderPosition > manifestPosition, commandOrder);
    assert.equal(readFileSync(bundleMetadataPath, 'utf8').trim(), 'candidate-012345678|0123456789abcdef0123456789abcdef01234567|2.0.0-canary.012345678|required|passed|test-gate-run-1|test-run-1');
    const indexPosition = nodeCommands.indexOf('tools/kb-create/scripts/prepare-release-index.mjs');
    const bundlePosition = nodeCommands.indexOf('plugins/release/scripts/create-candidate-bundle.mjs');
    assert.ok(indexPosition >= 0, nodeCommands);
    assert.ok(bundlePosition > indexPosition, nodeCommands);
    assert.equal(nodeCommands.split('release build run --flow platform --json').length - 1, 1, nodeCommands);
    assert.equal(nodeCommands.split('release artifact create --flow platform --out-dir .kb/release/artifacts --json').length - 1, 1, nodeCommands);
    assert.equal(nodeCommands.split('release version update --flow platform --channel canary --json').length - 1, 1, nodeCommands);
    assert.equal(nodeCommands.split('tools/kb-create/scripts/prepare-binary-manifest.mjs').length - 1, 1, nodeCommands);
    assert.equal(nodeCommands.split('--test tools/kb-create/scripts/prepare-binary-manifest.preflight.mjs').length - 1, 1, nodeCommands);
    assert.equal(nodeCommands.split('tools/kb-create/scripts/prepare-release-index.mjs').length - 1, 1, nodeCommands);
    assert.equal(nodeCommands.split('plugins/release/scripts/create-candidate-bundle.mjs').length - 1, 1, nodeCommands);
    assert.equal(commandOrder.split('goreleaser release --snapshot --clean --skip=publish').length - 1, 1, commandOrder);
    assert.equal(readFileSync(goArgsPath, 'utf8').split('-C tools/kb-create run ./v2/cmd/kb-create-release-index provenance').length - 1, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
