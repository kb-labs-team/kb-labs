/**
 * Maps WorkflowRun steps into a structured pipeline model for visualization.
 *
 * Step types:
 *   shell    — builtin:shell (agent run, build, review, etc.)
 *   approval — builtin:approval (human checkpoint)
 *   gate     — builtin:gate (auto decision with optional rework loop)
 *
 * Phase detection: explicit `step.spec.phase` first, fallback to heuristic by step name.
 * Phase ordering: uses `run.spec.phases` order when available, otherwise discovery order.
 */

import { useMemo } from 'react'
import type { WorkflowRun, StepRun } from '@kb-labs/workflow-contracts'

export type PipelineStepType = 'shell' | 'approval' | 'gate'

export interface PipelineStep {
  stepRun: StepRun
  stepType: PipelineStepType
  phase: string
  /** For gate steps with restartFrom — the index of the target step */
  reworkTargetIndex?: number
  /** For gate steps in active rework loop */
  iteration?: { current: number; max: number }
}

export interface PipelinePhase {
  label: string
  steps: PipelineStep[]
}

export interface ReworkLoop {
  /** Index of the gate step in the flat steps array */
  gateIndex: number
  /** Index of the step to restart from */
  targetIndex: number
  isActive: boolean
}

export interface PipelineModel {
  phases: PipelinePhase[]
  /** Flat ordered list for iteration */
  steps: PipelineStep[]
  reworkLoop: ReworkLoop | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectStepType(step: StepRun): PipelineStepType {
  const uses = step.spec?.uses ?? ''
  if (uses === 'builtin:approval') {return 'approval'}
  if (uses === 'builtin:gate') {return 'gate'}
  return 'shell'
}

function assignPhase(step: StepRun, index: number, allSteps: StepRun[]): string {
  // Explicit phase wins over heuristic
  if (step.spec?.phase) { return step.spec.phase }

  const name = step.name.toLowerCase()

  if (name.includes('plan') || name.includes('spec') || name.includes('research')) {return 'Planning'}
  if (name.includes('approve plan') || name.includes('tech lead')) {return 'Planning'}
  if (name.includes('implement') || name.includes('develop') || name.includes('cod')) {return 'Implementation'}
  if (name.includes('review') || name.includes('qa') || name.includes('test') || name.includes('lint')) {return 'Quality'}
  if (name.includes('security') || name.includes('license') || name.includes('compliance')) {return 'Quality'}
  if (name.includes('commit') || name.includes('deploy') || name.includes('release') || name.includes('publish')) {return 'Delivery'}
  if (name.includes('notify') || name.includes('done') || name.includes('complet')) {return 'Delivery'}

  // Approval nodes: inherit phase from previous step
  if (step.spec?.uses === 'builtin:approval' && index > 0) {
    const prev = allSteps[index - 1]
    if (prev) {return assignPhase(prev, index - 1, allSteps)}
  }

  // Gate nodes: inherit phase from previous step
  if (step.spec?.uses === 'builtin:gate' && index > 0) {
    const prev = allSteps[index - 1]
    if (prev) {return assignPhase(prev, index - 1, allSteps)}
  }

  return 'Implementation'
}

function findReworkLoop(
  steps: PipelineStep[],
): ReworkLoop | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step || step.stepType !== 'gate') {continue}
    const routes = step.stepRun.spec?.with?.routes as Record<string, unknown> | undefined
    if (!routes) {continue}
    for (const route of Object.values(routes)) {
      if (typeof route !== 'object' || route === null || !('restartFrom' in route)) {continue}
      const restartFrom = (route as Record<string, unknown>).restartFrom as string
      const targetIdx = steps.findIndex(
        s => s.stepRun.id.endsWith(`:${restartFrom}`) ||
             s.stepRun.name.toLowerCase() === restartFrom.toLowerCase()
      )
      if (targetIdx !== -1) {
        const isActive = step.stepRun.status === 'failed' || step.stepRun.status === 'running'
        return { gateIndex: i, targetIndex: targetIdx, isActive }
      }
    }
  }
  return null
}

function getMaxIterations(step: StepRun): number {
  const max = step.spec?.with?.maxIterations
  return typeof max === 'number' ? max : 3
}

function getIterationCount(step: StepRun): number {
  const meta = step.metadata as Record<string, unknown> | undefined
  const value = meta?.iterations
  return typeof value === 'number' ? value : 1
}

// ─── Main hook ────────────────────────────────────────────────────────────────

export function usePipelineModel(run: WorkflowRun | null | undefined): PipelineModel {
  return useMemo(() => {
    const empty: PipelineModel = { phases: [], steps: [], reworkLoop: null }
    if (!run?.jobs?.length) {return empty}

    const job = run.jobs[0]
    if (!job?.steps.length) {return empty}

    const rawSteps = job.steps

    // Build flat pipeline steps
    const steps: PipelineStep[] = rawSteps.map((s, i) => ({
      stepRun: s,
      stepType: detectStepType(s),
      phase: assignPhase(s, i, rawSteps),
    }))

    // Find rework loop
    const reworkLoop = findReworkLoop(steps)

    // Annotate gate with iteration info
    if (reworkLoop) {
      const gateStep = steps[reworkLoop.gateIndex]
      if (gateStep && reworkLoop.isActive) {
        const max = getMaxIterations(gateStep.stepRun)
        gateStep.iteration = { current: getIterationCount(gateStep.stepRun), max }
      }
    }

    // Group into phases
    const phaseMap = new Map<string, PipelineStep[]>()
    for (const step of steps) {
      if (!phaseMap.has(step.phase)) {
        phaseMap.set(step.phase, [])
      }
      phaseMap.get(step.phase)!.push(step)
    }

    // Use explicit phase order from spec if available, otherwise discovery order
    // WorkflowRun may carry `spec.phases` at runtime even if not in the TS schema
    const specPhases = (run as WorkflowRun & { spec?: { phases?: Array<{ label: string }> } }).spec?.phases
    const phaseOrder: string[] = specPhases
      ? specPhases.map((p) => p.label).filter((l) => phaseMap.has(l))
      : Array.from(phaseMap.keys())

    // Append any phases present in steps but not declared in spec
    for (const key of phaseMap.keys()) {
      if (!phaseOrder.includes(key)) { phaseOrder.push(key) }
    }

    const phases: PipelinePhase[] = phaseOrder.map(label => ({
      label,
      steps: phaseMap.get(label)!,
    }))

    return { phases, steps, reworkLoop }
  }, [run])
}
