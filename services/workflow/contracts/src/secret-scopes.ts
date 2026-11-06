import type { JobRun, JobSpec, StepRun, StepSpec, WorkflowSpec } from './types'

type StepSecretScope = Pick<StepSpec, 'secrets'> | Pick<StepRun, 'spec'>
type JobSecretScope = Pick<JobSpec, 'secrets' | 'steps' | 'hooks'> | Pick<JobRun, 'secrets' | 'steps' | 'hooks'>

export function getStepSecretNames(step: StepSecretScope): string[] {
  return 'spec' in step ? [...(step.spec.secrets ?? [])] : [...(step.secrets ?? [])]
}

export function getJobSecretNames(job: JobSecretScope): string[] {
  const names = [...(job.secrets ?? [])]
  for (const step of job.steps) names.push(...getStepSecretNames(step))
  for (const hookSteps of Object.values(job.hooks ?? {})) {
    for (const step of hookSteps ?? []) names.push(...getStepSecretNames(step))
  }
  return [...new Set(names)]
}

export function getWorkflowSecretNames(workflow: Pick<WorkflowSpec, 'secrets' | 'jobs'>): string[] {
  const names = [...(workflow.secrets ?? [])]
  for (const job of Object.values(workflow.jobs)) names.push(...getJobSecretNames(job))
  return [...new Set(names)]
}
