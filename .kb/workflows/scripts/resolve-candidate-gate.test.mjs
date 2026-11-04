import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import { platformFlowPolicies } from '../../../plugins/release/src/core/platform-flow-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptPath = resolve(root, '.kb/workflows/scripts/resolve-candidate-gate.mjs');
const workflowPath = resolve(root, '.github/workflows/release-build-candidate.yml');

test('candidate gate resolver follows the declared platform channel policy', () => {
  for (const [channel, expected, targetName] of [['stable', 'true', 'npm'], ['canary', 'false', 'local']]) {
    const actual = execFileSync(process.execPath, [scriptPath, '--flow', 'platform', '--channel', channel], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(actual, `required=${expected}\ntarget=${targetName}`);
    assert.equal(platformFlowPolicies.platform.gatePolicy[channel].policy === 'release-cases', expected === 'true');
    assert.equal(platformFlowPolicies.platform.deliveryTargets[targetName].kind, channel === 'stable' ? 'public' : 'test');
  }
});

test('candidate workflow gates stable builds and lets canary builds proceed when the gate is skipped', () => {
  const workflow = yaml.load(readFileSync(workflowPath, 'utf8'));
  assert.equal(workflow.jobs['resolve-gate-policy'].outputs.required, '${{ steps.policy.outputs.required }}');
  assert.equal(workflow.jobs['resolve-gate-policy'].outputs.target, '${{ steps.policy.outputs.target }}');
  assert.equal(workflow.jobs['journey-gate'].if, "needs.resolve-gate-policy.outputs.required == 'true'");
  assert.deepEqual(workflow.jobs.build.needs, ['resolve-gate-policy', 'journey-gate']);
  assert.match(workflow.jobs.build.if, /needs\.resolve-gate-policy\.outputs\.required != 'true' && needs\.journey-gate\.result == 'skipped'/);
  assert.match(workflow.jobs.build.if, /needs\.resolve-gate-policy\.outputs\.required == 'true' && needs\.journey-gate\.result == 'success'/);

  const deliveryWorkflow = yaml.load(readFileSync(resolve(root, '.github/workflows/release-deliver-candidate.yml'), 'utf8'));
  const targetResolution = deliveryWorkflow.jobs.deliver.steps.find(step => step.name === 'Resolve declared channel delivery target');
  const deliver = deliveryWorkflow.jobs.deliver.steps.find(step => step.name === 'Deliver exact candidate tarballs');
  assert.equal(targetResolution.id, 'delivery-target');
  assert.match(deliver.env.TARGET, /steps\.delivery-target\.outputs\.target/);
  assert.match(deliver.run, /--target "\$TARGET"/);
  assert.equal(deliveryWorkflow.jobs.deliver.services.verdaccio.ports[0], '4873:4873');
  assert.match(deliveryWorkflow.jobs.deliver.services.verdaccio.volumes[0], /\.kb\/verdaccio\/config\.yaml/);
});
