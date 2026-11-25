import { verifyCandidateWorkflowRun } from './candidate-workflow-run.mjs';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const token = required('GITHUB_TOKEN');
const repository = required('GITHUB_REPOSITORY');
const runId = required('CANDIDATE_RUN_ID');
const expectedBranch = process.env.TRUSTED_WORKFLOW_BRANCH || 'master';
if (!/^\d+$/.test(runId)) throw new Error('Candidate workflow run ID must contain digits only');

const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  },
});
if (!response.ok) throw new Error(`Could not verify candidate workflow run (${response.status})`);
verifyCandidateWorkflowRun(await response.json(), { repository, expectedBranch });
console.log(`Verified candidate workflow run ${runId} from ${repository}/${expectedBranch}.`);
