import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function readWorkflows() {
  const workflowRoot = join(root, '.github/workflows');
  return readdirSync(workflowRoot)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({
      file,
      workflow: load(readFileSync(join(workflowRoot, file), 'utf8')),
    }));
}

function findLocalActionWiringIssues(workflows) {
  const issues = [];

  for (const { file, workflow } of workflows) {
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses?.startsWith('./')) {
        const reusableWorkflowPath = resolve(root, job.uses.slice(2));
        if (!existsSync(reusableWorkflowPath)) {
          issues.push(`${file}: job ${jobId} does not resolve reusable workflow ${job.uses}`);
        } else {
          const reusableWorkflow = load(readFileSync(reusableWorkflowPath, 'utf8'));
          if (!Object.hasOwn(reusableWorkflow.on ?? {}, 'workflow_call')) {
            issues.push(`${file}: job ${jobId} target ${job.uses} is not a reusable workflow`);
          }
        }
      }

      let checkedOutAtWorkspaceRoot = false;
      for (const [stepIndex, step] of (job.steps ?? []).entries()) {
        if (step.uses?.startsWith('./')) {
          const actionDirectory = resolve(root, step.uses.slice(2));
          const location = `${file}: job ${jobId}, step ${stepIndex + 1} (${step.uses})`;
          if (!checkedOutAtWorkspaceRoot) {
            issues.push(`${location} has no prior root checkout in this job`);
          }
          if (!existsSync(join(actionDirectory, 'action.yml')) && !existsSync(join(actionDirectory, 'action.yaml'))) {
            issues.push(`${location} does not resolve to a local composite action`);
          }
        }

        if (step.uses?.startsWith('actions/checkout@')) {
          const checkoutPath = step.with?.path;
          if (!checkoutPath || checkoutPath === '.') checkedOutAtWorkspaceRoot = true;
        }
      }
    }
  }

  return issues;
}

test('local actions resolve after checkout and reusable workflows resolve as call targets', () => {
  const issues = findLocalActionWiringIssues(readWorkflows());
  assert.deepEqual(issues, []);
});
