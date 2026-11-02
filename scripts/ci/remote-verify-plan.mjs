#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const selectionCommand = 'node scripts/ci/resolve-remote-selection.mjs "$VERIFICATION_PROFILE" "$RUNNER_TEMP/affected-packages.json" ./tools/kb-devkit/kb-devkit';
const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));

export function parseAffectedPackages(output) {
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch (error) {
    throw new Error(`Remote package selection was not valid JSON (${error.message}). Rerun the prepare selector: ${selectionCommand}.`);
  }
  const packages = envelope?.data?.packages;
  if (envelope?.ok !== true || !Array.isArray(packages) || packages.some((name) => typeof name !== 'string' || !name)) {
    throw new Error(`Remote package selection did not return a successful package list. Rerun the prepare selector: ${selectionCommand}.`);
  }
  if (new Set(packages).size !== packages.length) throw new Error(`kb-devkit returned a duplicate package name. Rerun the prepare selector: ${selectionCommand}.`);
  return packages;
}

export function parseAffectedSelection(output, profileName) {
  const packages = parseAffectedPackages(output);
  const envelope = JSON.parse(output);
  const internalToolPackages = envelope?.data?.internalToolPackages;
  const stagePackages = envelope?.data?.stagePackages;
  const changedPathCount = envelope?.data?.changedPathCount;
  if (!Number.isSafeInteger(changedPathCount) || changedPathCount < 0) throw new Error(`kb-devkit affected selection is missing its changed-path count. Rerun the prepare selector: ${selectionCommand}.`);
  if (!Array.isArray(internalToolPackages) || internalToolPackages.some((name) => typeof name !== 'string' || !name) || new Set(internalToolPackages).size !== internalToolPackages.length || internalToolPackages.some((name) => !packages.includes(name))) {
    throw new Error(`kb-devkit affected selection returned an invalid internal-tool package list. Rerun the prepare selector: ${selectionCommand}.`);
  }
  if (!stagePackages || typeof stagePackages !== 'object' || Array.isArray(stagePackages)) throw new Error(`Remote package selection did not include its manifest-backed stage packages. Rerun the prepare selector: ${selectionCommand}.`);
  for (const [stage, names] of Object.entries(stagePackages)) {
    if (!profile.stages[stage] || profile.stages[stage].runner !== 'kb-devkit-test-package' || !Array.isArray(names) || names.length !== 1 || names.some((name) => typeof name !== 'string' || !name)) {
      throw new Error(`Remote package selection contains invalid stage package data for ${stage}. Rerun the prepare selector: ${selectionCommand}.`);
    }
  }
  if (packages.length === 0 && profileName === 'stream' && changedPathCount > 0) {
    throw new Error(`KB_REMOTE_EMPTY_SELECTION: ${profileName} resolved ${changedPathCount} changed path(s) to zero workspace packages. Check the base-ref input and registry, then rerun the prepare selector: ${selectionCommand}.`);
  }
  const selectionReason = envelope?.data?.selectionReason ?? '';
  if (typeof selectionReason !== 'string') throw new Error(`kb-devkit affected selection returned an invalid selection reason. Rerun the prepare selector: ${selectionCommand}.`);
  if (profileName === 'candidate' && packages.length === 0 && Object.keys(stagePackages).length === 0) {
    throw new Error(`KB_REMOTE_EMPTY_SELECTION: candidate resolved ${changedPathCount} changed path(s) to zero workspace packages. Check the base-ref input and registry, then rerun the prepare selector: ${selectionCommand}.`);
  }
  const internalSet = new Set(internalToolPackages);
  return {
    packages: profileName === 'candidate' ? packages.filter((name) => !internalSet.has(name)) : packages,
    internalToolPackages: profileName === 'candidate' ? internalToolPackages : [],
    stagePackages,
    changedPathCount,
    selectionReason,
  };
}

export function createTestMatrix(packagesOrSelection, independentStages, buildDependentStages, packageTestStage, shardLimit, stagePackages = {}) {
  const selection = Array.isArray(packagesOrSelection) ? { packages: packagesOrSelection, internalToolPackages: [], stagePackages } : packagesOrSelection;
  const packages = selection.packages;
  stagePackages = selection.stagePackages ?? stagePackages;
  if (!Number.isSafeInteger(shardLimit) || shardLimit < 1) throw new Error('Verification profile maxParallel must be a positive integer.');
  if (new Set(packages).size !== packages.length) throw new Error('Affected package selection contains a duplicate package.');
  const testStages = [...independentStages, ...buildDependentStages];
  if (new Set(testStages).size !== testStages.length) throw new Error('Verification profile contains a duplicate test stage.');
  const shardCount = Math.min(packages.length, shardLimit);
  const packageShards = Array.from({ length: shardCount }, (_, index) => ({
    stage: packageTestStage,
    shard: index + 1,
    packages: [],
  }));
  packages.forEach((packageName, index) => packageShards[index % shardCount].packages.push(packageName));
  const stageEntry = (stage) => stagePackages[stage]
    ? { stage, shard: 1, packages: stagePackages[stage] }
    : { stage };
  const independent = { include: independentStages.map(stageEntry) };
  const dependent = { include: [...buildDependentStages.map(stageEntry), ...packageShards] };
  const internalShardCount = Math.min(selection.internalToolPackages.length, shardLimit);
  const internalTool = {
    include: Array.from({ length: internalShardCount }, (_, index) => ({ stage: 'internal-tool-tests', shard: index + 1, packages: [] })),
  };
  selection.internalToolPackages.forEach((packageName, index) => internalTool.include[index % internalShardCount].packages.push(packageName));
  return {
    independent,
    dependent,
    include: [...independent.include, ...dependent.include],
    internalTool,
  };
}

function main() {
  const [profileName, affectedPath, planPath, outputPath] = process.argv.slice(2);
  if (!profileName || !affectedPath || !planPath || !outputPath) throw new Error('Usage: node scripts/ci/remote-verify-plan.mjs <stream|candidate> <affected-json> <plan-json> <github-output>');
  const { packages, internalToolPackages, stagePackages, changedPathCount, selectionReason } = parseAffectedSelection(readFileSync(affectedPath, 'utf8'), profileName);
  const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
  const independentStages = profile.independentTestStages[profileName];
  const buildDependentStages = profile.buildDependentTestStages[profileName];
  if (!independentStages || !buildDependentStages) throw new Error(`Unknown verification profile ${profileName}; use stream or candidate.`);
  const matrix = createTestMatrix({ packages, internalToolPackages, stagePackages }, independentStages, buildDependentStages, profile.packageTestStage, profile.maxParallel);
  writeFileSync(planPath, `${JSON.stringify(matrix)}\n`);
  const selection = JSON.parse(readFileSync(affectedPath, 'utf8')).data;
  appendFileSync(outputPath, `test_matrix=${JSON.stringify({ include: matrix.include })}\nindependent_matrix=${JSON.stringify(matrix.independent)}\nbuild_dependent_matrix=${JSON.stringify(matrix.dependent)}\ninternal_tool_matrix=${JSON.stringify(matrix.internalTool)}\ninternal_tool_packages=${internalToolPackages.join(',')}\nbuild_stage=${profile.buildStage}\npackages=${packages.join(',')}\nselected_packages=${JSON.stringify(packages)}\nselected_package_count=${packages.length}\nselection_mode=${selection.mode ?? 'full'}\nselection_base_sha=${selection.baseSha ?? ''}\nselection_reason=${selectionReason}\nmax_parallel=${profile.maxParallel}\nshard_timeout_minutes=${profile.shardTimeoutMinutes}\n`);
  process.stdout.write(`Planned ${matrix.include.length} test shard(s) from ${packages.length} kb-devkit-selected package(s).\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
