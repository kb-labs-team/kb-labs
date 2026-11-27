import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { checkCoverageFloor, countAcceptedThresholdViolations, findNewThresholdViolations } from './coverage-floor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const floor = JSON.parse(readFileSync(path.join(root, 'scripts/ci/coverage-floor.json'), 'utf8'));

function resultFor(overrides = {}) {
  return {
    packages: Object.entries(floor.metrics).map(([name, metrics]) => ({
      package: name,
      ...Object.fromEntries(Object.entries(metrics).map(([metric, pct]) => [metric, { pct, total: 1 }])),
      ...(overrides[name] ?? {}),
    })),
  };
}

test('coverage floor matches its unchanged-source hosted measurement and tolerates equal or improved metrics', () => {
  assert.match(floor.reference.sha, /^[a-f0-9]{40}$/);
  assert.match(floor.reference.measurementSha, /^[a-f0-9]{40}$/);
  assert.ok(Number.isInteger(floor.reference.runId));
  assert.ok(Number.isInteger(floor.reference.jobId));

  const coverageConfig = load(readFileSync(path.join(root, 'devkit.yaml'), 'utf8')).coverage;
  for (const [packageName, metrics] of Object.entries(floor.metrics)) {
    const category = Object.entries(coverageConfig.categories).find(([pattern]) =>
      new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(packageName))?.[1];
    const thresholds = category && coverageConfig.thresholds[category];
    assert.ok(thresholds, `${packageName} has an enforced target category`);
    for (const [metric, minimum] of Object.entries(metrics)) {
      assert.ok(minimum < thresholds[metric], `${packageName} ${metric} is an observed target miss`);
    }
  }

  assert.deepEqual(checkCoverageFloor(resultFor(), floor), []);

  const improved = resultFor({ '@kb-labs/shared-cli-ui': { branches: { pct: 35.5, total: 100 } } });
  assert.deepEqual(checkCoverageFloor(improved, floor), []);

  const noInstrumentedBranches = resultFor({ '@kb-labs/studio-ui-core': { branches: { pct: 0, total: 0 } } });
  assert.deepEqual(checkCoverageFloor(noInstrumentedBranches, floor), []);
});

test('coverage floor rejects worsened metrics and missing accepted packages or metrics', () => {
  const worsened = resultFor({ '@kb-labs/core-sandbox': { functions: { pct: 24.9, total: 100 } } });
  assert.deepEqual(checkCoverageFloor(worsened, floor), [{
    type: 'regression', package: '@kb-labs/core-sandbox', metric: 'functions', actual: 24.9, minimum: 25,
  }]);

  const missingPackage = resultFor();
  missingPackage.packages = missingPackage.packages.filter((pkg) => pkg.package !== '@kb-labs/sdk');
  assert.deepEqual(checkCoverageFloor(missingPackage, floor), [{ type: 'missing-package', package: '@kb-labs/sdk' }]);

  const missingMetric = resultFor({ '@kb-labs/sdk': { branches: undefined } });
  assert.deepEqual(checkCoverageFloor(missingMetric, floor), [{
    type: 'missing-metric', package: '@kb-labs/sdk', metric: 'branches', minimum: 67.7,
  }]);
});

test('known target misses remain visible but only new misses block the gate', () => {
  const targetMisses = [
    { package: '@kb-labs/sdk', metric: 'branches', actual: 67.7, limit: 80 },
    { package: '@kb-labs/new-package', metric: 'functions', actual: 39, limit: 40 },
  ];
  const newMisses = findNewThresholdViolations(targetMisses, floor);

  assert.equal(targetMisses.length, 2, 'the full raw target miss list is retained');
  assert.deepEqual(newMisses, [targetMisses[1]], 'a new threshold miss without an accepted floor blocks');
  assert.equal(countAcceptedThresholdViolations(targetMisses, floor), 1);
});

test('coverage summary artifact uploads after a failing coverage check', () => {
  const workflow = load(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs.coverage.steps;
  const run = steps.findIndex((step) => step.name === 'Run coverage');
  const upload = steps[run + 1];
  assert.ok(upload.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.name, 'coverage-summary-${{ github.run_id }}');
  assert.equal(upload.with.path, 'coverage/summary.json');
  assert.equal(upload.with['if-no-files-found'], 'warn');
  assert.equal(upload.with['retention-days'], 7);
});
