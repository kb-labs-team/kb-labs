import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('project-scoped workflow lint registers the checkout in a job-local KB_HOME first', () => {
  const workflow = readYaml('.github/workflows/ci-pr.yml');
  const job = workflow.jobs['devkit-checks'];
  const configureIndex = job.steps.findIndex((step) => step.name === 'Configure job-local project registry');
  const registerIndex = job.steps.findIndex((step) => step.name === 'Register checkout for project-scoped CLI checks');
  const lintIndex = job.steps.findIndex((step) => step.name === 'Lint workflow definitions');
  assert.equal(job.steps[configureIndex]?.run, 'echo "KB_HOME=${RUNNER_TEMP}/kb-home" >> "$GITHUB_ENV"');
  assert.ok(configureIndex >= 0 && registerIndex > configureIndex && lintIndex > registerIndex, 'temporary registry configuration and checkout registration run before workflow lint');
  assert.equal(job.steps[registerIndex].run, 'pnpm kb project add "$GITHUB_WORKSPACE"');
});

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
  assert.equal(prepare.env.REMOTE_BASE_REF, "${{ github.event_name == 'push' && format('origin/{0}', github.event.repository.default_branch) || '' }}");
  assert.equal(prepare.env.REMOTE_TARGET_SHA, '${{ inputs.target_sha || github.sha }}');
  assert.equal(workflow.on.workflow_dispatch.inputs.base_ref, undefined);
  assert.equal(workflow.on.workflow_call.inputs.base_ref, undefined);
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
  assert.equal(internalTools.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ inputs.target_sha || github.sha }}');
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

// case: S-262.15
test('candidate PR label runs full verification for the exact head without secrets or write permissions', () => {
  const pr = readYaml('.github/workflows/ci-pr.yml');
  const remote = readYaml('.github/workflows/remote-verify.yml');
  const release = readYaml('.github/workflows/release-build-candidate.yml');
  const candidate = pr.jobs['candidate-verification'];
  assert.deepEqual(pr.on.pull_request.types, ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']);
  assert.equal(pr.concurrency['cancel-in-progress'], true);
  assert.equal(pr.concurrency.group, 'ci-pr-${{ github.event.pull_request.number }}');
  assert.equal(candidate.if, "contains(github.event.pull_request.labels.*.name, 'candidate')");
  assert.equal(candidate.needs, undefined);
  assert.equal(candidate.name, 'Full candidate verification (${{ github.event.pull_request.head.sha }})');
  assert.equal(candidate.uses, './.github/workflows/remote-verify.yml');
  assert.equal(candidate.with.profile, 'candidate');
  assert.equal(candidate.with.target_sha, '${{ github.event.pull_request.head.sha }}');
  assert.equal(candidate.with.job_prefix, 'Full candidate verification (${{ github.event.pull_request.head.sha }}) / ');
  assert.deepEqual(candidate.permissions, { contents: 'read', actions: 'read', checks: 'read' });
  assert.equal(Object.hasOwn(candidate, 'secrets'), false);
  assert.ok(!Object.values(pr.jobs).some((job) => job.permissions?.contents === 'write' && job.uses === './.github/workflows/remote-verify.yml'));

  const internalCheckout = remote.jobs['internal-tool-test-shards'].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(internalCheckout.with.ref, '${{ inputs.target_sha || github.sha }}');
  for (const job of Object.values(remote.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with.ref, '${{ inputs.target_sha || github.sha }}');
    }
  }
  assert.equal(Object.hasOwn(remote.on, 'schedule'), false);
  assert.ok(Object.values(remote.jobs).every((job) => job.permissions?.contents !== 'write'));
  const cleanup = readYaml('.github/workflows/sweep-verify-refs.yml');
  assert.ok(Object.hasOwn(cleanup.on, 'schedule'));
  assert.equal(cleanup.permissions.contents, 'read');
  assert.equal(cleanup.jobs['sweep-verify-refs'].permissions.contents, 'write');
  assert.equal(remote.on.workflow_call.inputs.job_prefix.required, false);
  assert.equal(remote.on.workflow_call.inputs.job_prefix.default, '');
  assert.equal(release.jobs['unit-test-gate'].uses, './.github/workflows/remote-verify.yml');
  assert.equal(release.jobs['unit-test-gate'].name, 'Workspace unit verification');
  assert.equal(release.jobs['unit-test-gate'].with.job_prefix, 'Workspace unit verification / ');
  const workflowDir = path.join(root, '.github/workflows');
  const remoteCallers = readdirSync(workflowDir).filter((file) => file.endsWith('.yml')).flatMap((file) => {
    const workflow = readYaml(path.join('.github/workflows', file));
    return Object.entries(workflow.jobs ?? {}).filter(([, job]) => job.uses === './.github/workflows/remote-verify.yml')
      .map(([jobId, job]) => ({ caller: `${file}#${jobId}`, prefix: job.with?.job_prefix }));
  }).sort((a, b) => a.caller.localeCompare(b.caller));
  assert.deepEqual(remoteCallers, [
    { caller: 'ci-pr.yml#candidate-verification', prefix: 'Full candidate verification (${{ github.event.pull_request.head.sha }}) / ' },
    { caller: 'release-build-candidate.yml#unit-test-gate', prefix: 'Workspace unit verification / ' },
  ]);
});

test('journey batch and candidate route builds through the same runner entry', () => {
  const batch = readYaml('.github/workflows/journey-batch.yml');
  const candidate = readYaml('.github/workflows/remote-verify.yml');
  const batchBuild = batch.jobs.producer.steps.find((step) => step.name === 'Produce shared build and candidate');
  const batchSteps = batch.jobs.producer.steps;
  const batchCas = batchSteps.find((step) => step.id === 'devkit-cas');
  const candidateBuild = candidate.jobs.build.steps.find((step) => step.name === 'Build selected workspace packages once');
  assert.equal(batch.jobs.producer.env.KB_DEVKIT_BASE_REF, "${{ github.event.pull_request.base.sha || format('origin/{0}', github.event.repository.default_branch) }}");
  assert.equal(batchBuild.run, 'node scripts/ci/run-remote-stage.mjs --journey-batch-prepare "$BATCH_PRODUCER_OUTPUT" "$BATCH_BASELINE"');
  assert.ok(batchSteps.indexOf(batchCas) < batchSteps.indexOf(batchBuild), 'restore the shared DevKit CAS before the batch build');
  assert.equal(batchCas.uses, './.github/actions/devkit-cas');
  assert.equal(batchBuild.env.DEVKIT_CACHE_HIT, '${{ steps.devkit-cas.outputs.cache-hit }}');
  assert.equal(candidateBuild.run, 'node scripts/ci/run-remote-stage.mjs');
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
  assert.equal(cache.with.path.trim(), '${{ steps.resolve-store.outputs.path }}/objects\n${{ steps.resolve-store.outputs.path }}/tasks');
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
  assert.equal(cas.outputs['store-path'].value, '${{ steps.resolve-store.outputs.path }}');
  assert.ok(cas.runs.steps.some((step) => step.id === 'resolve-store' && step.run.includes('resolve-shared-root.sh')));
  assert.ok(profile.buildDependentTestStages.candidate.includes('journey-unit-suite'));
  assert.ok(!profile.buildDependentTestStages.stream.includes('journey-unit-suite'));
});

test('DevKit CAS cache path follows the repository shared store and isolates nested fixtures', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-devkit-cas-path-'));
  try {
    const repository = path.join(temporaryRoot, 'repository');
    mkdirSync(repository);
    execFileSync('git', ['init', '--quiet', repository]);
    const output = path.join(temporaryRoot, 'github-output');
    execFileSync('bash', [path.join(root, '.github/actions/devkit-cas/resolve-shared-root.sh'), repository, output]);
    assert.equal(readFileSync(output, 'utf8').trim(), `path=${path.join(realpathSync(repository), '.git', 'kb-devkit')}`);

    const nested = path.join(repository, 'e2e', 'fixture');
    mkdirSync(nested, { recursive: true });
    writeFileSync(output, '');
    execFileSync('bash', [path.join(root, '.github/actions/devkit-cas/resolve-shared-root.sh'), nested, output]);
    assert.equal(readFileSync(output, 'utf8').trim(), `path=${path.join(realpathSync(nested), '.kb', 'devkit', 'shared')}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
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
    assert.equal(prepare.env.VERIFICATION_PROFILE, "${{ inputs.profile || github.event.inputs.profile || 'stream' }}");
    assert.equal(prepare.env.REMOTE_BASE_REF, "${{ github.event_name == 'push' && format('origin/{0}', github.event.repository.default_branch) || '' }}");
    assert.equal(prepare.env.REMOTE_REF_NAME, '${{ github.ref_name }}');
    mkdirSync(home);
    const goPaths = execFileSync('go', ['env', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' }).trim().split('\n');
    const controlledGoEnv = { PATH: process.env.PATH, HOME: home, GOPATH: goPaths[0], GOMODCACHE: goPaths[1], GOCACHE: goPaths[2], GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', GOENV: 'off' };
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: path.join(root, 'tools/kb-devkit'), env: controlledGoEnv, stdio: 'pipe' });
    const affectedPath = path.join(temporaryRoot, 'affected.json');
    const selectionRun = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', affectedPath, binary], {
      cwd: root, encoding: 'utf8', env: { ...controlledGoEnv, VERIFICATION_PROFILE: 'candidate', REMOTE_REF_NAME: 'master' },
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
    const serviceE2ePackage = '@kb-labs/e2e-services';
    const pluginE2ePackage = '@kb-labs/e2e-plugins';
    const webPackage = 'kb-labs-web';
    assert.ok(selection.packages.includes(serviceE2ePackage), 'candidate build selection must retain the services E2E package');
    assert.ok(!selection.unitTestPackages.includes(serviceE2ePackage), 'services E2E package has no unit-test task');
    assert.ok(!gatedPackages.includes(serviceE2ePackage), 'services E2E package must not create an empty unit-test shard');
    assert.ok(selection.packages.includes(pluginE2ePackage), 'candidate build selection must retain the plugin E2E package');
    assert.ok(!selection.unitTestPackages.includes(pluginE2ePackage), 'plugin E2E package has an e2e task, not a unit-test task');
    assert.ok(selection.packages.includes(webPackage), 'candidate build selection must retain the web package');
    assert.ok(!selection.unitTestPackages.includes(webPackage), 'web package has no unit-test task');
    assert.ok(!selection.internalToolPackages.includes(kbRunnerModule), 'frozen kb-runner tests are absent from automatic internal-tool shards');
    assert.ok(selection.skippedManualTasks.some((task) => task.package === kbRunnerModule && task.task === 'test'), 'prepare evidence reports the frozen task as manually skipped');
    assert.match(outputs, /skipped_manual_tasks=.*kb-labs\/kb-runner/);
    assert.ok(!gatedPackages.includes(kbRunnerModule));
    for (const name of ['@kb-labs/commit', '@kb-labs/e2e-delivery', '@kb-labs/e2e-shared', '@kb-labs/e2e-platform', '@kb-labs/e2e-llm-deterministic', '@kb-labs/core-platform']) {
      assert.ok(gatedPackages.includes(name), `candidate plan omitted ${name}`);
    }
    assert.deepEqual(gatedPackages.sort(), selection.unitTestPackages.sort());
    assert.deepEqual(matrix.dependent.include.find(({ stage }) => stage === 'kb-create-go-suite'), {
      stage: 'kb-create-go-suite', shard: 1, packages: ['kb-create'],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('candidate selector forces full package checks for every non-stream ref despite base_ref input', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-ref-policy-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  try {
    const home = path.join(temporaryRoot, 'home');
    mkdirSync(home);
    const goPaths = execFileSync('go', ['env', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' }).trim().split('\n');
    const controlledGoEnv = { PATH: process.env.PATH, HOME: home, GOPATH: goPaths[0], GOMODCACHE: goPaths[1], GOCACHE: goPaths[2], GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', GOENV: 'off' };
    execFileSync('go', ['build', '-o', fakeDevkit, '.'], { cwd: path.join(root, 'tools/kb-devkit'), env: controlledGoEnv, stdio: 'pipe' });
    const workflow = readYaml('.github/workflows/remote-verify.yml');
    const prepareEnv = workflow.jobs.prepare.env;
    assert.equal(prepareEnv.REMOTE_REF_NAME, '${{ github.ref_name }}');
    let fullPackages;
    for (const branch of ['agent/j90-integration', 'master', 'release/1.0', 'feature/other', 'verify-candidate/release/20261118T120000Z-abc']) {
      const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', selectionPath, fakeDevkit], {
        cwd: root,
        encoding: 'utf8',
        env: { ...controlledGoEnv, VERIFICATION_PROFILE: 'candidate', REMOTE_REF_NAME: branch, REMOTE_BASE_REF: 'HEAD' },
      });
      assert.equal(producer.status, 0, `${branch} selector failed: ${producer.stderr}`);
      const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
      assert.equal(selection.mode, 'full', `${branch} must run full regardless of base_ref`);
      assert.match(selection.selectionReason, /^full:/i);
      assert.ok(selection.packages.length > 0, `${branch} must not return an empty workspace selection`);
      if (!fullPackages) fullPackages = selection.packages;
      assert.deepEqual(selection.packages, fullPackages, `${branch} must select the complete workspace package set`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('verify stream detects a trusted base that resolves to HEAD and explains the full fallback', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-head-base-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nif [ "$1" = "show-ref" ] && [ "$4" = "refs/remotes/origin/master" ]; then exec '${realGit}' rev-parse HEAD; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'verify/stream/head-base', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(producer.status, 0, `HEAD-equal candidate selector failed: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(selection.mode, 'full');
    assert.match(selection.selectionReason, /full: selected base resolves to HEAD/i);
    assert.deepEqual(selection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('verify stream selects affected packages against the pinned master SHA', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-eligible-stream-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nif [ "$1" = "show-ref" ] && [ "$4" = "refs/remotes/origin/master" ]; then exec '${realGit}' rev-parse HEAD^; fi\nif [ "$1" = "diff" ]; then printf '%s\\n' 'core/plugin-contracts/src/color-policy.mjs'; exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'verify/stream/affected', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(producer.status, 0, `eligible agent selection failed: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(selection.mode, 'affected');
    assert.equal(selection.selectionReason, 'affected');
    assert.match(selection.baseSha, /^[0-9a-f]{40}$/);
      assert.equal(selection.changedPathCount, 1);
    assert.deepEqual(selection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('verify stream pins the trusted remote ref once and runs real Git plus DevKit selection', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-real-git-'));
  const fixture = path.join(temporaryRoot, 'checkout');
  const binary = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  const gitLog = path.join(temporaryRoot, 'git-commands.log');
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  try {
    const goPaths = execFileSync('go', ['env', 'GOPATH', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' }).trim().split('\n');
    const home = path.join(temporaryRoot, 'home');
    mkdirSync(home);
    const goEnv = { PATH: process.env.PATH, HOME: home, GOPATH: goPaths[0], GOMODCACHE: goPaths[1], GOCACHE: goPaths[2], GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', GOENV: 'off' };
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: path.join(root, 'tools/kb-devkit'), env: goEnv, stdio: 'pipe' });
    execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
    execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: fixture, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Remote selection test'], { cwd: fixture });
    execFileSync('git', ['config', 'user.email', 'remote-selection@example.invalid'], { cwd: fixture });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/master', baseSha], { cwd: fixture });
    for (const file of ['resolve-remote-selection.mjs', 'remote-selection-base.mjs', 'remote-changed-files.mjs']) {
      copyFileSync(path.join(root, 'scripts/ci', file), path.join(fixture, 'scripts/ci', file));
    }
    const changedFile = path.join(fixture, 'core/platform/src/index.ts');
    writeFileSync(changedFile, `${readFileSync(changedFile, 'utf8')}\n// remote selection fixture\n`);
    execFileSync('git', ['add', 'core/platform/src/index.ts'], { cwd: fixture });
    execFileSync('git', ['commit', '-m', 'test: change one package for remote selection'], { cwd: fixture, stdio: 'pipe' });
    const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nif [ "$1" = "merge-base" ]; then '${realGit}' update-ref refs/remotes/origin/master '${targetSha}'; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    const result = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, binary], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...goEnv, PATH: `${gitShim}:${process.env.PATH}`, DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: targetSha, REMOTE_REF_NAME: 'verify/integration-fixture', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(result.status, 0, `real Git/DevKit resolver failed: ${result.stderr}`);
    const selected = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    const fullPath = path.join(temporaryRoot, 'full.json');
    const fullResult = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', fullPath, binary], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...goEnv, PATH: `${gitShim}:${process.env.PATH}`, DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: targetSha, REMOTE_REF_NAME: 'master', REMOTE_BASE_REF: '' },
    });
    assert.equal(fullResult.status, 0, `real full-selection resolver failed: ${fullResult.stderr}`);
    const full = JSON.parse(readFileSync(fullPath, 'utf8')).data;
    assert.equal(selected.mode, 'affected');
    assert.equal(selected.baseSha, baseSha);
    assert.equal(selected.changedPathCount, 1);
    assert.ok(selected.packages.includes('@kb-labs/core-platform'));
    assert.ok(selected.packages.length < full.packages.length);
    const commands = readFileSync(gitLog, 'utf8').trim().split('\n');
    const resolveCommands = commands.filter((command) => command === `show-ref --verify --hash refs/remotes/origin/master`);
    assert.equal(resolveCommands.length, 1, 'the canonical remote base must be resolved exactly once');
    assert.ok(commands.includes(`merge-base ${baseSha} ${targetSha}`));
    assert.ok(commands.some((command) => command.includes(`${baseSha} ${targetSha}`)));
    assert.equal(execFileSync('git', ['show-ref', '--verify', '--hash', 'refs/remotes/origin/master'], { cwd: fixture, encoding: 'utf8' }).trim(), targetSha);

    const mismatch = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, binary], {
      cwd: fixture, encoding: 'utf8', env: { ...goEnv, PATH: `${gitShim}:${process.env.PATH}`, DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: '0'.repeat(40), REMOTE_REF_NAME: 'verify/target-mismatch', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match requested target/);

    execFileSync('git', ['checkout', '--detach', baseSha], { cwd: fixture, stdio: 'pipe' });
    writeFileSync(path.join(fixture, 'core/platform/src/divergent-fixture.ts'), 'export const divergent = true;\n');
    execFileSync('git', ['add', 'core/platform/src/divergent-fixture.ts'], { cwd: fixture });
    execFileSync('git', ['commit', '-m', 'test: divergent baseline'], { cwd: fixture, stdio: 'pipe' });
    const divergedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/master', divergedSha], { cwd: fixture });
    execFileSync('git', ['checkout', '--detach', targetSha], { cwd: fixture, stdio: 'pipe' });
    const divergentPath = path.join(temporaryRoot, 'divergent.json');
    const divergent = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', divergentPath, binary], {
      cwd: fixture, encoding: 'utf8', env: { ...goEnv, PATH: `${gitShim}:${process.env.PATH}`, DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: targetSha, REMOTE_REF_NAME: 'verify/divergent-base', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(divergent.status, 0, `divergent base did not use full fallback: ${divergent.stderr}`);
    const divergentSelection = JSON.parse(readFileSync(divergentPath, 'utf8')).data;
    assert.equal(divergentSelection.mode, 'full');
    assert.match(divergentSelection.selectionReason, /not an ancestor/);

    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/master'], { cwd: fixture });
    execFileSync('git', ['tag', 'master', baseSha], { cwd: fixture });
    const missingBasePath = path.join(temporaryRoot, 'missing-base.json');
    const missingBase = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', missingBasePath, binary], {
      cwd: fixture, encoding: 'utf8', env: { ...goEnv, PATH: `${gitShim}:${process.env.PATH}`, DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: targetSha, REMOTE_REF_NAME: 'verify/missing-exact-ref', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(missingBase.status, 0, `missing exact ref did not use full fallback: ${missingBase.stderr}`);
    const missingSelection = JSON.parse(readFileSync(missingBasePath, 'utf8')).data;
    assert.equal(missingSelection.mode, 'full');
    assert.match(missingSelection.selectionReason, /base could not be resolved/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('candidate remains full and verify stream uses the pinned master commit', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-trunk-stream-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nif [ "$1" = "show-ref" ] && [ "$4" = "refs/remotes/origin/master" ]; then exec '${realGit}' rev-parse HEAD^; fi\nif [ "$1" = "diff" ]; then printf '%s\\n' 'core/platform/src/index.ts'; exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    for (const branch of ['batch/cases/S-010.1', 'verify/short-lived-fix', 'verify-candidate/release/sha']) {
      const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', selectionPath, fakeDevkit], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'candidate', REMOTE_REF_NAME: branch, REMOTE_BASE_REF: 'origin/master' },
      });
      assert.equal(producer.status, 0, `${branch} selection failed: ${producer.stderr}`);
      const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
      assert.equal(selection.mode, 'full', branch);
      assert.match(selection.selectionReason, /candidate verification selects the complete workspace/);
    }
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'verify/stream/sha', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(producer.status, 0, `verify stream selection failed: ${producer.stderr}`);
    const streamSelection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(streamSelection.mode, 'affected');
    assert.equal(streamSelection.changedPathCount, 1);
    assert.deepEqual(streamSelection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('verify stream converts an empty diff to a full selection with a reason', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-empty-diff-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nif [ "$1" = "show-ref" ] && [ "$4" = "refs/remotes/origin/master" ]; then exec '${realGit}' rev-parse HEAD^; fi\nif [ "$1" = "diff" ]; then exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'verify/stream/empty', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(producer.status, 0, `empty-diff selector failed: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(selection.mode, 'full');
    assert.equal(selection.changedPathCount, 0);
    assert.match(selection.selectionReason, /full: candidate diff is empty/);
    assert.deepEqual(selection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('verify stream retries an empty result for a non-empty diff using the complete selection', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-empty-result-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const callsPath = path.join(temporaryRoot, 'calls');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nif [ "$1" = "show-ref" ] && [ "$4" = "refs/remotes/origin/master" ]; then exec '${realGit}' rev-parse HEAD^; fi\nif [ "$1" = "diff" ]; then printf '%s\\n' 'core/platform/src/index.ts'; exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    writeFileSync(fakeDevkit, `#!/bin/sh\ncalls=0\n[ ! -f "$REMOTE_SELECTION_CALLS" ] || calls=$(cat "$REMOTE_SELECTION_CALLS")\ncalls=$((calls + 1))\nprintf '%s' "$calls" > "$REMOTE_SELECTION_CALLS"\nif [ "$calls" -eq 1 ]; then printf '%s\\n' '{"ok":true,"data":{"packages":[],"testPackages":[],"internalToolPackages":[],"selectionReason":"affected"}}'; else printf '%s\\n' '{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"full: complete workspace"}}'; fi\n`);
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'verify/stream/empty-affected', REMOTE_BASE_REF: 'origin/master', REMOTE_SELECTION_CALLS: callsPath },
    });
    assert.equal(producer.status, 0, `empty affected selection did not fall back: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(readFileSync(callsPath, 'utf8'), '2');
    assert.equal(selection.mode, 'full');
    assert.match(selection.selectionReason, /full: empty affected selection for a non-empty diff/);
    assert.deepEqual(selection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('candidate workflow dispatch has no affected-base input and always selects full', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-forged-dispatch-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  try {
    const workflow = readYaml('.github/workflows/remote-verify.yml');
    const prepareEnv = workflow.jobs.prepare.env;
    assert.equal(prepareEnv.REMOTE_REF_NAME, '${{ github.ref_name }}');
    assert.equal(prepareEnv.REMOTE_BASE_REF, "${{ github.event_name == 'push' && format('origin/{0}', github.event.repository.default_branch) || '' }}");
    assert.equal(workflow.on.workflow_dispatch.inputs.base_ref, undefined);
    assert.equal(workflow.on.workflow_call.inputs.base_ref, undefined);
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'candidate', selectionPath, fakeDevkit], {
      cwd: root, encoding: 'utf8', env: { ...process.env, VERIFICATION_PROFILE: 'candidate', REMOTE_REF_NAME: 'verify-candidate/release/sha', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(producer.status, 0, `forged dispatch selector failed: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(selection.mode, 'full');
    assert.match(selection.selectionReason, /candidate verification selects the complete workspace/);
    assert.deepEqual(selection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('stream profile cannot run affected checks on a protected ref with supplied master base', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-protected-stream-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  try {
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}\'\n');
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'master', REMOTE_BASE_REF: 'origin/master' },
    });
    assert.equal(producer.status, 0, `protected stream selection failed: ${producer.stderr}`);
    const selection = JSON.parse(readFileSync(selectionPath, 'utf8')).data;
    assert.equal(selection.mode, 'full');
    assert.match(selection.selectionReason, /full: ref master is not eligible for affected selection/);
    assert.deepEqual(selection.packages, ['@kb-labs/core-platform']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('verify stream retries a malformed affected selection against the full workspace', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-selection-fallback-'));
  const selectionPath = path.join(temporaryRoot, 'selection.json');
  const callsPath = path.join(temporaryRoot, 'calls');
  const fakeDevkit = path.join(temporaryRoot, 'kb-devkit');
  const gitShim = path.join(temporaryRoot, 'git-shim');
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    mkdirSync(gitShim);
    writeFileSync(path.join(gitShim, 'git'), `#!/bin/sh\nif [ "$1" = "show-ref" ] && [ "$4" = "refs/remotes/origin/master" ]; then exec '${realGit}' rev-parse HEAD^; fi\nif [ "$1" = "diff" ]; then printf '%s\\n' 'core/platform/src/index.ts'; exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(gitShim, 'git'), 0o755);
    writeFileSync(fakeDevkit, `#!/bin/sh\ncalls=0\n[ ! -f "$REMOTE_SELECTION_CALLS" ] || calls=$(cat "$REMOTE_SELECTION_CALLS")\ncalls=$((calls + 1))\nprintf '%s' "$calls" > "$REMOTE_SELECTION_CALLS"\nif [ "$calls" -eq 1 ]; then printf 'not-json\n'; else printf '%s\n' '{"ok":true,"data":{"packages":["@kb-labs/core-platform"],"testPackages":["@kb-labs/core-platform"],"internalToolPackages":[],"selectionReason":"affected"}}'; fi\n`);
    chmodSync(fakeDevkit, 0o755);
    const producer = spawnSync(process.execPath, ['scripts/ci/resolve-remote-selection.mjs', 'stream', selectionPath, fakeDevkit], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${gitShim}:${process.env.PATH}`, VERIFICATION_PROFILE: 'stream', DEFAULT_BRANCH: 'master', REMOTE_TARGET_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), REMOTE_REF_NAME: 'verify/x231-test-strategy', REMOTE_BASE_REF: 'origin/master', REMOTE_SELECTION_CALLS: callsPath },
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
    writeFileSync(fakeDevkit, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"packages":["@kb-labs/core-platform","github.com/kb-labs/kb-runner"],"testPackages":["@kb-labs/core-platform","github.com/kb-labs/kb-runner"],"internalToolPackages":["github.com/kb-labs/kb-runner"],"selectionReason":"fixture"}}\'\n');
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
