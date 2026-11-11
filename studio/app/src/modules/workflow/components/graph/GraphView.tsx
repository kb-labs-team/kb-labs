/**
 * Graph view — node/edge visualization of a job's step control flow.
 *
 * Step level only for now (all workflows in .kb/workflows/ are single-job).
 * Node ids are namespaced (`step:<id>`) and `buildStepGraph` takes a single
 * JobRun so a future job-level DAG can be added as a second lane in this
 * same canvas without renaming anything here.
 */

import { useState, useMemo } from 'react'
import ReactFlow, { Background, Controls, type NodeMouseHandler } from 'reactflow'
import 'reactflow/dist/style.css'
import type { WorkflowRun, StepRun } from '@kb-labs/workflow-contracts'
import type { WorkflowLogEvent } from '@kb-labs/workflow-contracts/rest-api'
import { useWorkflowGraph } from '../../hooks/use-workflow-graph'
import { StepNode } from './StepNode'
import { WorkflowEdge } from './WorkflowEdge'
import { StepDetailDrawer } from '../pipeline/StepDetailDrawer'

const nodeTypes = { workflowStep: StepNode }
const edgeTypes = { workflowEdge: WorkflowEdge }

interface GraphViewProps {
  run: WorkflowRun
  events: WorkflowLogEvent[]
  onApprove?: (step: StepRun) => void
}

export function GraphView({ run, events, onApprove }: GraphViewProps) {
  const jobIndex = 0
  const job = run.jobs?.[jobIndex]
  const { nodes, edges } = useWorkflowGraph(run, jobIndex)
  const [selected, setSelected] = useState<StepRun | null>(null)
  // Branch/loop arcs (restartFrom, skipTo) are dimmed by default — with
  // several gates in one run they'd otherwise all stack on top of each
  // other with no way to tell which arc belongs to which gate. Hovering
  // (or clicking) the gate brings just its own arcs to full opacity.
  const [focusStepId, setFocusStepId] = useState<string | null>(null)

  const styledEdges = useMemo(
    () => edges.map(e => {
      const isArc = e.data?.kind === 'restartFrom' || e.data?.kind === 'skipTo'
      const sourceStepId = e.source.replace(/^step:/, '')
      const isFocused = focusStepId !== null && sourceStepId === focusStepId
      return {
        ...e,
        type: 'workflowEdge',
        data: { ...e.data, dimmed: isArc && !isFocused },
      }
    }),
    [edges, focusStepId],
  )

  if (!job?.steps.length) {
    return <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 14 }}>No execution data yet.</div>
  }

  const stepIdFromNode = (nodeId: string) => nodeId.replace(/^step:/, '')

  const handleNodeClick: NodeMouseHandler = (_evt, node) => {
    const stepId = stepIdFromNode(node.id)
    const step = job.steps.find(s => s.id === stepId)
    if (step) {setSelected(step)}
  }

  const handleNodeMouseEnter: NodeMouseHandler = (_evt, node) => {
    setFocusStepId(stepIdFromNode(node.id))
  }

  const handleNodeMouseLeave: NodeMouseHandler = () => {
    setFocusStepId(null)
  }

  const stepEvents = events.filter(e => e.stepId === selected?.id)
  const hasArcs = edges.some(e => e.data?.kind === 'restartFrom' || e.data?.kind === 'skipTo')

  return (
    <div style={{ position: 'relative' }}>
      {hasArcs && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          fontSize: 12, color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 16, height: 0, borderTop: '1.5px solid var(--border-primary)' }} />
            normal path
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 16, height: 0, borderTop: '2px dashed var(--warning)' }} />
            ↩ rework loop (hover the gate)
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 16, height: 0, borderTop: '1.5px dotted var(--text-tertiary)' }} />
            ⇥ forward skip (hover the gate)
          </span>
        </div>
      )}
      <div
        key={job.id}
        style={{
          height: 640,
          border: '1px solid var(--border-primary)',
          borderRadius: 8,
          background: 'var(--bg-primary)',
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={styledEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={handleNodeClick}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="var(--border-primary)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <StepDetailDrawer
        step={selected}
        events={stepEvents}
        open={selected !== null}
        onClose={() => setSelected(null)}
        onApprove={
          selected?.status === 'waiting_approval' && onApprove
            ? () => { onApprove(selected); setSelected(null) }
            : undefined
        }
      />
    </div>
  )
}
