import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import test from 'node:test';
import { parseAffectedSelection } from './remote-verify-plan.mjs';
import { aggregateVerdict } from './aggregate-remote-verdict.mjs';
import { runStage } from './remote-verify-stage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const readYaml = (file) => load(readFileSync(path.join(root, file), 'utf8'));

// case: S-262.7
test('remote verification builds once and fans out independent and artifact-dependent test matrices', () => {
  const workflow = readYaml('.github/workflows/remote-verify.yml');
  const prepare = workflow.jobs.prepare;
  const build = workflow.jobs.build;
  const independent = workflow.jobs['independent-test-shards'];
  const dependent = workflow.jobs['build-dependent-test-shards'];
  const internalTools = workflow.jobs['internal-tool-test-shards'];
  const finalize = workflow.jobs.verdict;
  const prepareResultUpload = prepare.steps.find((step) => step.name === 'Upload prepare stage result');
  const aggregateStep = finalize.steps.find((step) => step.name === 'Aggregate commit-bound verdict');
  const prepareSteps = prepare.steps;
  const buildSteps = build.steps;
  const independentSteps = independent.steps;
  const dependentSteps = dependent.steps;
  const dependentResultUpload = dependentSteps.find((step) => step.name === 'Upload build-dependent test result');

  assert.ok(prepare.steps.some((step) => step.run === 'node scripts/ci/run-remote-prepare.mjs'));
  assert.equal(prepareResultUpload.if, 'always()');
  assert.equal(prepareResultUpload.with.name, 'remote-result-prepare');
  assert.equal(prepareResultUpload.with.path, 'stage-result-prepare.json');
  assert.equal(aggregateStep.env.PREPARE_JOB_RESULT, '${{ needs.prepare.result }}');
  assert.equal(build.needs, 'prepare');
  assert.equal(independent.needs, 'prepare');
  assert.equal(independent.strategy.matrix, '${{ fromJSON(needs.prepare.outputs.independent_matrix) }}');
  assert.equal(dependent.needs, 'build');
  assert.equal(internalTools.needs, 'prepare');
  assert.equal(internalTools['continue-on-error'], true);
  assert.equal(internalTools.strategy.matrix, '${{ fromJSON(needs.prepare.outputs.internal_tool_matrix) }}');
  assert.equal(internalTools['timeout-minutes'], '${{ fromJSON(needs.prepare.outputs.shard_timeout_minutes) }}');
  assert.equal(dependent.strategy.matrix, '${{ fromJSON(needs.build.outputs.build_dependent_matrix) }}');
  assert.equal(dependentSteps.find((step) => step.name === 'Run build-dependent test').env.REMOTE_STAGE_RESULT, 'stage-result-dependent-${{ matrix.stage }}-${{ matrix.shard || strategy.job-index }}.json');
  assert.equal(dependentResultUpload.with.name, 'remote-result-dependent-${{ matrix.stage }}-${{ matrix.shard || strategy.job-index }}');
  assert.equal(dependentResultUpload.with.path, 'stage-result-dependent-${{ matrix.stage }}-${{ matrix.shard || strategy.job-index }}.json');
  assert.equal(independent.strategy['fail-fast'], "${{ inputs.profile != 'candidate' }}");
  assert.equal(dependent.strategy['fail-fast'], "${{ inputs.profile != 'candidate' }}");
  assert.equal(independent.strategy['max-parallel'], '${{ fromJSON(needs.prepare.outputs.max_parallel) }}');
  assert.equal(dependent.strategy['max-parallel'], '${{ fromJSON(needs.build.outputs.max_parallel) }}');
  assert.equal(build.outputs.build_dependent_matrix, '${{ needs.prepare.outputs.build_dependent_matrix }}');
  assert.equal(prepare.outputs.selected_package_count, '${{ steps.plan.outputs.selected_package_count }}');
  assert.equal(prepare.outputs.internal_tool_matrix, '${{ steps.plan.outputs.internal_tool_matrix }}');
  assert.equal(prepare.outputs.internal_tool_packages, '${{ steps.plan.outputs.internal_tool_packages }}');
  assert.equal(prepare.outputs.shard_timeout_minutes, '${{ steps.plan.outputs.shard_timeout_minutes }}');
  assert.equal(build.outputs.shard_timeout_minutes, '${{ needs.prepare.outputs.shard_timeout_minutes }}');
  assert.equal(independent['timeout-minutes'], '${{ fromJSON(needs.prepare.outputs.shard_timeout_minutes) }}');
  assert.equal(dependent['timeout-minutes'], '${{ fromJSON(needs.build.outputs.shard_timeout_minutes) }}');
  assert.equal(build.outputs.selected_package_count, '${{ needs.prepare.outputs.selected_package_count }}');
  assert.equal(independent.env.REMOTE_SELECTED_PACKAGE_COUNT, '${{ needs.prepare.outputs.selected_package_count }}');
  assert.equal(dependent.env.REMOTE_SELECTED_PACKAGE_COUNT, '${{ needs.build.outputs.selected_package_count }}');
  assert.equal(aggregateStep.env.REMOTE_SELECTED_PACKAGE_COUNT, "${{ needs.prepare.outputs.selected_package_count || '0' }}");
  const buildRun = buildSteps.find((step) => step.name === 'Build selected workspace packages once');
  assert.equal(buildRun.env.REMOTE_STAGE, '${{ needs.prepare.outputs.build_stage }}');
  assert.equal(buildRun.env.REMOTE_RESOURCE_SAMPLES, 'stage-resource-samples.jsonl');
  assert.ok(!prepareSteps.some((step) => step.name === 'Install workspace dependencies'));
  assert.ok(buildSteps.some((step) => step.uses === './.github/actions/devkit-cas'));
  assert.ok(independentSteps.some((step) => step.uses === './.github/actions/devkit-cas'));
  assert.ok(dependentSteps.some((step) => step.uses === './.github/actions/devkit-cas'));
  assert.ok(independentSteps.some((step) => step.uses?.startsWith('actions/download-artifact@')));
  assert.ok(dependentSteps.some((step) => step.uses?.startsWith('actions/download-artifact@')));
  assert.ok(dependentSteps.some((step) => step.run === 'tar xf workspace-dist.tar'));
  assert.ok(buildSteps.some((step) => step.uses?.startsWith('actions/upload-artifact@')));
  const resourceUpload = buildSteps.find((step) => step.name === 'Upload build result and resource evidence');
  assert.equal(resourceUpload.if, 'always()');
  assert.equal(resourceUpload.with.path, 'stage-result-build.json\nstage-resource-samples.jsonl\n');
  assert.equal(aggregateStep.env.BUILD_JOB_RESULT, '${{ needs.build.result }}');
  assert.equal(aggregateStep.env.BUILD_RESOURCE_SAMPLES, 'remote-results/stage-resource-samples.jsonl');
  assert.equal(aggregateStep.env.GH_TOKEN, '${{ github.token }}');
  assert.ok(finalize.needs.includes('independent-test-shards'));
  assert.ok(finalize.needs.includes('build-dependent-test-shards'));
  assert.ok(finalize.needs.includes('internal-tool-test-shards'));
  assert.equal(aggregateStep.env.REMOTE_INTERNAL_TOOL_MATRIX, '${{ needs.prepare.outputs.internal_tool_matrix }}');
  assert.equal(buildSteps.filter((step) => step.name === 'Build selected workspace packages once').length, 1);
});

// case: S-262.7
test('remote verification reuses the existing lockfile, Go module, and kb-devkit CAS cache owners', () => {
  const workflow = readYaml('.github/workflows/remote-verify.yml');
  const steps = workflow.jobs.prepare.steps;
  const nodeSetup = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const goSetup = steps.find((step) => step.uses?.startsWith('actions/setup-go@'));
  const cas = readYaml('.github/actions/devkit-cas/action.yml');
  const cache = cas.runs.steps.find((step) => step.uses?.startsWith('actions/cache@'));
  const profile = JSON.parse(readFileSync(path.join(root, 'scripts/ci/verification-profile.json'), 'utf8'));

  assert.equal(nodeSetup.with.cache, 'pnpm');
  assert.equal(goSetup.with['cache-dependency-path'], 'tools/kb-create/go.sum');
  assert.equal(cache.with.path, '.kb/devkit/');
  assert.match(cache.with.key, /\$\{\{ github\.sha \}\}/);
  const toolchain = cas.runs.steps.find((step) => step.name === 'Identify cache toolchain partition');
  assert.equal(toolchain.id, 'toolchain');
  assert.match(toolchain.run, /node --version/);
  assert.match(toolchain.run, /go version/);
  assert.match(cache.with.key, /runner\.arch/);
  assert.match(cache.with.key, /steps\.toolchain\.outputs\.partition/);
  assert.doesNotMatch(cache.with.key, /hashFiles\(/);
  assert.equal(cache.with['restore-keys'].trim(), 'devkit-cas-${{ runner.os }}-${{ runner.arch }}-${{ steps.toolchain.outputs.partition }}-');
  assert.equal(cas.outputs['cache-hit'].value, '${{ steps.restore.outputs.cache-hit }}');
  assert.ok(profile.buildDependentTestStages.candidate.includes('journey-unit-suite'));
  assert.ok(!profile.buildDependentTestStages.stream.includes('journey-unit-suite'));
});

// case: S-262.7
test('candidate producer-to-plan uses real workspace selection and keeps shipped package families', () => {
  const workflow = readYaml('.github/workflows/remote-verify.yml');
  const prepare = workflow.jobs.prepare;
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-workspace-'));
  const home = path.join(temporaryRoot, 'home');
  const binary = path.join(temporaryRoot, 'kb-devkit');
  try {
    assert.equal(prepare.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
    assert.equal(workflow.env.DEFAULT_BRANCH, '${{ github.event.repository.default_branch }}');
    assert.equal(prepare.env.VERIFICATION_PROFILE, "${{ github.event.inputs.profile || 'stream' }}");
  assert.equal(prepare.env.REMOTE_BASE_REF, "${{ github.event.inputs.base_ref || '' }}");
    mkdirSync(home);
    const goPaths = execFileSync('go', ['env', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' }).trim().split('\n');
    const controlledGoEnv = { PATH: process.env.PATH, HOME: home, GOPATH: goPaths[0], GOMODCACHE: goPaths[1], GOCACHE: goPaths[2], GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', GOENV: 'off' };
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: path.join(root, 'tools/kb-devkit'), env: controlledGoEnv, stdio: 'pipe' });
    const affectedPath = path.join(temporaryRoot, 'affected.json');
    const selectionRun = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', affectedPath, binary], {
      cwd: root, encoding: 'utf8', env: { ...controlledGoEnv, VERIFICATION_PROFILE: 'candidate' },
    });
    assert.equal(selectionRun.status, 0, `real candidate selection failed: ${selectionRun.stderr}`);
    const affected = readFileSync(affectedPath, 'utf8');
    const selectionEvidence = JSON.parse(affected).data;
    const selection = parseAffectedSelection(affected, 'candidate');
    assert.equal(selectionEvidence.mode, 'full');
    assert.match(selectionEvidence.baseSha, /^[0-9a-f]{40}$/);
    const sharedInputPath = path.join(temporaryRoot, 'shared-inputs.json');
    writeFileSync(sharedInputPath, JSON.stringify(['core/plugin-contracts/src/color-policy.mjs']));
    const sharedSelection = spawnSync(binary, ['--config', path.join(root, 'devkit.yaml'), 'affected', '--changed-files-file', sharedInputPath, '--json'], {
      cwd: root, encoding: 'utf8', env: controlledGoEnv,
    });
    assert.equal(sharedSelection.status, 0, `real shared-input selection failed: ${sharedSelection.stderr}`);
    const sharedData = JSON.parse(sharedSelection.stdout).data;
    assert.equal(sharedData.selectionReason, 'full: configured shared input core/plugin-contracts/src/color-policy.mjs');
    assert.equal(sharedData.packages.length, selectionEvidence.packages.length);
    const planPath = path.join(temporaryRoot, 'plan.json');
    const githubOutput = path.join(temporaryRoot, 'github-output');
    const planRun = spawnSync(process.execPath, ['scripts/ci/remote-verify-plan.mjs', 'candidate', affectedPath, planPath, githubOutput], { cwd: root, encoding: 'utf8' });
    assert.equal(planRun.status, 0, `real candidate plan failed: ${planRun.stderr}`);
    const matrix = JSON.parse(readFileSync(planPath, 'utf8'));
    const outputs = readFileSync(githubOutput, 'utf8');
    assert.match(outputs, /selection_mode=full/);
    assert.match(outputs, /selection_base_sha=[0-9a-f]{40}/);
    assert.match(outputs, /selected_packages=\[/);
    const gatedPackages = matrix.dependent.include.filter(({ stage }) => stage === profile.packageTestStage).flatMap(({ packages = [] }) => packages);
    const kbRunnerModule = 'github.com/kb-labs/kb-runner';
    assert.ok(selection.internalToolPackages.includes(kbRunnerModule));
    assert.ok(!gatedPackages.includes(kbRunnerModule));
    for (const name of ['@kb-labs/commit', '@kb-labs/e2e-plugins', '@kb-labs/e2e-shared', '@kb-labs/e2e-platform', '@kb-labs/e2e-llm-deterministic', 'kb-labs-web', '@kb-labs/core-platform']) {
      assert.ok(gatedPackages.includes(name), `candidate plan omitted ${name}`);
    }
    assert.deepEqual(gatedPackages.sort(), selection.packages.sort());
    assert.deepEqual(matrix.dependent.include.find(({ stage }) => stage === 'kb-create-go-suite'), {
      stage: 'kb-create-go-suite', shard: 1, packages: ['kb-create'],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('candidate retries a malformed affected selection against the full workspace', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-fallback-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const callsPath = path.join(temporaryRoot, 'calls');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  try {
    writeFileSync(fakeDevkit, `#!/bin/sh\ncalls=0\n[ ! -f "$REMOTE_SELECTION_CALLS" ] || calls=$(cat "$REMOTE_SELECTION_CALLS")\ncalls=$((calls + 1))\nprintf '%s' "$calls" > "$REMOTE_SELECTION_CALLS"\nif [ "$calls" -eq 1 ]; then printf 'not-json\n'; else printf '%s\n' '{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}'; fi\n`);
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', selectionPath, fakeDevkit], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VERIFICATION_PROFILE: 'candidate', REMOTE_BASE_REF: 'HEAD', REMOTE_SELECTION_CALLS: callsPath },
    });
    assert.equal(producer.status, 0, `candidate selection did not fall back to full: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(readFileSync(callsPath, 'utf8'), '2');
    assert.equal(selection.mode, 'full');
    assert.equal(selection.selectionReason, 'full: affected computation failed; selected the complete workspace');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('candidate producer, plan, stage, and aggregate preserve the manifest stage shard identity', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-stage-identity-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const planPath = path.join(temporaryRoot, 'plan.json');
  const githubOutput = path.join(temporaryRoot, 'github-output');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  try {
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform","github.com/kb-labs/kb-runner"],"internalToolPackages":["github.com/kb-labs/kb-runner"],"selectionReason":"fixture"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    const env = { ...process.env, VERIFICATION_PROFILE: 'candidate' };
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', selectionPath, fakeDevkit], { cwd: root, encoding: 'utf8', env });
    assert.equal(producer.status, 0, `selection producer failed: ${producer.stderr}`);
    const planner = spawnSync(process.execPath, ['scripts/ci/remote-verify-plan.mjs', 'candidate', selectionPath, planPath, githubOutput], { cwd: root, encoding: 'utf8', env });
    assert.equal(planner.status, 0, `plan producer failed: ${planner.stderr}`);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const matrixEntry = plan.dependent.include.find((entry) => entry.stage === 'kb-create-go-suite');
    assert.deepEqual(matrixEntry, { stage: 'kb-create-go-suite', shard: 1, packages: ['kb-create'] });

    const result = await runStage({
      stage: matrixEntry.stage, packageNames: matrixEntry.packages, shard: matrixEntry.shard,
      selectedPackageCount: plan.include.length,
      runCommand: async () => ({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { results: [{ Package: 'kb-create', Task: 'test', OK: true, ExitCode: 0, Stdout: '', Stderr: '' }] } }),
        stderr: '',
      }),
    });
    const verdict = aggregateVerdict({
      sha: 'f'.repeat(40), prepare: { name: 'prepare', status: 'pass', selectedPackageCount: 1, failures: [], logTail: '' },
      build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '' },
      matrix: { include: [matrixEntry], internalTool: { include: [] } }, results: [result],
      selectedPackageCount: 1, verificationProfile: 'candidate', prepareJobResult: 'success', buildJobResult: 'success',
      githubJobs: [{ name: 'Build-dependent test 1', conclusion: 'success', steps: [], annotations: [] }],
    });
    assert.equal(verdict.jobs.at(-1).name, 'kb-create-go-suite:shard-1');
    assert.equal(verdict.jobs.at(-1).status, 'pass');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
