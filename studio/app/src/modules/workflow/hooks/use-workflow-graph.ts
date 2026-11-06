/**
 * Builds a node/edge graph of a job's steps for the Graph view.
 *
 * Unlike `usePipelineModel` (linear list), this surfaces the *actual* control
 * flow: gate steps have one labeled edge per route (`continue` / `fail` /
 * `restartFrom` / `skipTo`), consecutive steps sharing the same `if` form a
 * conditional block, and `restartFrom` back-edges are all resolved, not just
 * the first one found.
 *
 * `step.spec.if` is a skip guard, not a branch — it has no alternative
 * target, so it never produces a fork edge, only block grouping.
 */

import { useMemo } from 'react'
import type { Node, Edge } from 'reactflow'
import type { WorkflowRun, JobRun, StepRun } from '@kb-labs/workflow-contracts'

export type WorkflowGraphNodeType = 'shell' | 'approval' | 'gate' | 'fail'

export interface WorkflowGraphNodeData {
  stepRun: StepRun
  nodeType: WorkflowGraphNodeType
  blockId: string | null
  iterations?: number
  maxIterations?: number
  /** Number of non-default routes (restart/skip) this gate can take — shown
   *  on the node itself so a branch is discoverable without hunting for a
   *  faint arc first. */
  branchCount?: number
}

export type WorkflowGraphEdgeKind = 'next' | 'skipTo' | 'restartFrom'

export interface WorkflowGraphEdgeData {
  kind: WorkflowGraphEdgeKind
  label?: string
  /** Set by GraphView based on hover focus, not by buildStepGraph itself. */
  dimmed?: boolean
}

export interface WorkflowGraphModel {
  nodes: Node<WorkflowGraphNodeData>[]
  edges: Edge<WorkflowGraphEdgeData>[]
}

// ─── Route shape (builtin:gate) ────────────────────────────────────────────
// Mirrors GateRouteAction from @kb-labs/workflow-steps without taking a
// cross-package dependency for a single structural type.

type GateRouteAction =
  | 'continue'
  | 'fail'
  | { restartFrom: string; context?: Record<string, unknown> }
  | { skipTo: string }

function isGateStep(step: StepRun): boolean {
  return step.spec?.uses === 'builtin:gate'
}

function isApprovalStep(step: StepRun): boolean {
  return step.spec?.uses === 'builtin:approval'
}

function nodeTypeFor(step: StepRun): WorkflowGraphNodeType {
  if (isGateStep(step)) {return 'gate'}
  if (isApprovalStep(step)) {return 'approval'}
  return 'shell'
}

/** Resolve a route target (restartFrom/skipTo) to an index in `steps`. */
function resolveTargetIndex(steps: StepRun[], target: string): number {
  return steps.findIndex(
    s => s.spec?.id === target ||
         s.id.endsWith(`:${target}`) ||
         s.name.toLowerCase() === target.toLowerCase(),
  )
}

function getRoutes(step: StepRun): Record<string, GateRouteAction> | null {
  const routes = step.spec?.with?.routes as Record<string, GateRouteAction> | undefined
  return routes ?? null
}

function getMaxIterations(step: StepRun): number | undefined {
  const max = step.spec?.with?.maxIterations
  return typeof max === 'number' ? max : undefined
}

function getIterations(step: StepRun): number | undefined {
  const meta = step.metadata as Record<string, unknown> | undefined
  const value = meta?.iterations
  return typeof value === 'number' ? value : undefined
}

// ─── Node layout (spine + arc gutter, no layout library) ──────────────────

const ROW_HEIGHT = 110
const SPINE_X = 320

/** Groups consecutive steps sharing an identical, truthy `spec.if`. */
function computeBlocks(steps: StepRun[]): (string | null)[] {
  const blockIds: (string | null)[] = []
  let currentIf: string | undefined
  let currentBlockId: string | null = null
  let blockCounter = 0

  for (const step of steps) {
    const stepIf = step.spec?.if
    if (stepIf && stepIf === currentIf) {
      blockIds.push(currentBlockId)
    } else if (stepIf) {
      blockCounter += 1
      currentBlockId = `block-${blockCounter}`
      currentIf = stepIf
      blockIds.push(currentBlockId)
    } else {
      currentIf = undefined
      currentBlockId = null
      blockIds.push(null)
    }
  }
  return blockIds
}

export function buildStepGraph(job: JobRun): WorkflowGraphModel {
  const steps = job.steps
  const blockIds = computeBlocks(steps)

  const nodes: Node<WorkflowGraphNodeData>[] = steps.map((step, i) => ({
    id: `step:${step.id}`,
    type: 'workflowStep',
    // Single vertical spine — all steps share one x so the eye can read
    // execution order top-to-bottom without diagonal zigzag. Conditional
    // blocks are shown via a left accent on the node, not a lane offset.
    position: { x: SPINE_X, y: i * ROW_HEIGHT },
    data: {
      stepRun: step,
      nodeType: nodeTypeFor(step),
      blockId: blockIds[i] ?? null,
      iterations: isGateStep(step) ? getIterations(step) : undefined,
      maxIterations: isGateStep(step) ? getMaxIterations(step) : undefined,
    },
    draggable: false,
    connectable: false,
  }))

  const edges: Edge<WorkflowGraphEdgeData>[] = []
  const branchCountByStepId = new Map<string, number>()
  const edgeId = (() => {
    let n = 0
    return () => `e${n++}`
  })()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step) {continue}
    const sourceId = `step:${step.id}`

    if (!isGateStep(step)) {
      // Plain forward edge to the next step, if any.
      const next = steps[i + 1]
      if (next) {
        edges.push({
          id: edgeId(),
          source: sourceId,
          target: `step:${next.id}`,
          data: { kind: 'next' },
        })
      }
      continue
    }

    // Gate step: one labeled edge per route.
    const routes = getRoutes(step)
    if (!routes || Object.keys(routes).length === 0) {
      const next = steps[i + 1]
      if (next) {
        edges.push({
          id: edgeId(),
          source: sourceId,
          target: `step:${next.id}`,
          data: { kind: 'next' },
        })
      }
      continue
    }

    // `continue` always targets the next step by construction (it's the
    // pass-through path) — collapse every route key that resolves to
    // `continue` into a single unlabeled edge, same weight as a plain
    // sequential edge. Only genuine alternates (restart/skip) stand out.
    let continueEdgeAdded = false

    for (const [decisionKey, action] of Object.entries(routes)) {
      if (action === 'continue') {
        if (continueEdgeAdded) {continue}
        const next = steps[i + 1]
        if (next) {
          edges.push({
            id: edgeId(),
            source: sourceId,
            target: `step:${next.id}`,
            data: { kind: 'next' },
          })
          continueEdgeAdded = true
        }
        continue
      }
      if (action === 'fail') {
        // Terminal — no outgoing node target; represented by absence of edge,
        // label surfaced on the node itself via GateDecisionBanner-equivalent.
        continue
      }
      if (typeof action === 'object' && action !== null && 'restartFrom' in action) {
        const targetIdx = resolveTargetIndex(steps, action.restartFrom)
        const target = steps[targetIdx]
        if (target) {
          edges.push({
            id: edgeId(),
            source: sourceId,
            target: `step:${target.id}`,
            // Right-side handles, not the top/bottom spine handles — keeps
            // the whole arc to the right of the card column.
            sourceHandle: 'arc-source',
            targetHandle: 'arc-target',
            // Name the destination, not just the decision key, so the label
            // is self-explanatory without tracing the curve to its end.
            data: { kind: 'restartFrom', label: `${decisionKey} → ${target.name}` },
          })
          branchCountByStepId.set(step.id, (branchCountByStepId.get(step.id) ?? 0) + 1)
        }
        continue
      }
      if (typeof action === 'object' && action !== null && 'skipTo' in action) {
        const targetIdx = resolveTargetIndex(steps, action.skipTo)
        const target = steps[targetIdx]
        if (target) {
          edges.push({
            id: edgeId(),
            source: sourceId,
            target: `step:${target.id}`,
            sourceHandle: 'arc-source',
            targetHandle: 'arc-target',
            data: { kind: 'skipTo', label: `${decisionKey} → ${target.name}` },
          })
          branchCountByStepId.set(step.id, (branchCountByStepId.get(step.id) ?? 0) + 1)
        }
      }
    }
  }

  for (const node of nodes) {
    if (node.data.nodeType === 'gate') {
      node.data.branchCount = branchCountByStepId.get(node.data.stepRun.id) ?? 0
    }
  }

  return { nodes, edges }
}

export function useWorkflowGraph(run: WorkflowRun | null | undefined, jobIndex = 0): WorkflowGraphModel {
  return useMemo(() => {
    const empty: WorkflowGraphModel = { nodes: [], edges: [] }
    const job = run?.jobs?.[jobIndex]
    if (!job?.steps.length) {return empty}
    return buildStepGraph(job)
  }, [run, jobIndex])
}
