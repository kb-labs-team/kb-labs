/**
 * Custom edge for the Graph view.
 *
 * - `next`: plain solid line, grey, unlabeled, always full opacity — the
 *   pass-through path (including a gate's `continue` route, which is
 *   collapsed into this same kind by use-workflow-graph so the common case
 *   never looks like a branch).
 * - `restartFrom`: dashed warning-colored arrowed arc curving back and to
 *   the right — mirrors the restart coloring already used in PipelineView's
 *   GateDecisionBanner/ReworkBracket.
 * - `skipTo`: dotted muted arrowed arc curving forward and to the right,
 *   distinct from restartFrom so a forward jump never reads as a loop.
 *
 * Arcs are dimmed to near-invisible by default (`data.dimmed`, driven by
 * GraphView's hover-focus state) — with several gates in one run, all their
 * arcs stacked at full strength is illegible noise. Hovering (or clicking)
 * a gate brings only *its* arcs to full color, with a direction arrowhead
 * and a "key → target name" label so the meaning doesn't require tracing
 * the curve.
 *
 * Both ends anchor to each node's dedicated `arc-source`/`arc-target` Right
 * handle (see StepNode), not the top/bottom handles the spine uses — so
 * sourceX/targetX here are already at the card's right edge. The cubic
 * bezier's control points sit further right still (at `gutterX`), which
 * means by the convex-hull property every point of the curve has
 * `x >= min(sourceX, targetX)`: the arc can never cross back over a card,
 * not just "usually doesn't" — the geometry makes it impossible.
 */

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from 'reactflow'
import type { WorkflowGraphEdgeData } from '../../hooks/use-workflow-graph'

const KIND_COLOR: Record<string, string> = {
  next:        'var(--border-primary)',
  restartFrom: 'var(--warning)',
  skipTo:      'var(--text-tertiary)',
}

const KIND_DASH: Record<string, string | undefined> = {
  next:        undefined,
  restartFrom: '7 5',
  skipTo:      '2 5',
}

const GUTTER_BASE = 50
const GUTTER_PER_ROW = 16
const ROW_HEIGHT = 110
const ARROW_SIZE = 7

function arrowMarkerId(edgeId: string): string {
  return `wf-arrow-${edgeId}`
}

export function WorkflowEdge({
  id, sourceX, sourceY, targetX, targetY, data,
}: EdgeProps<WorkflowGraphEdgeData>) {
  const kind = data?.kind ?? 'next'
  const isArc = kind === 'restartFrom' || kind === 'skipTo'
  const color = KIND_COLOR[kind] ?? 'var(--border-primary)'
  const opacity = isArc && data?.dimmed ? 0.12 : 1

  if (!isArc) {
    const path = `M ${sourceX},${sourceY} L ${targetX},${targetY}`
    return <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: 1.5 }} />
  }

  // Swing distance scales with how many rows the jump spans, so a short
  // skip and a long rework loop don't ride the same line and cross.
  const rowSpan = Math.max(1, Math.round(Math.abs(targetY - sourceY) / ROW_HEIGHT))
  const gutterX = Math.max(sourceX, targetX) + GUTTER_BASE + rowSpan * GUTTER_PER_ROW

  const path = `M ${sourceX},${sourceY} C ${gutterX},${sourceY} ${gutterX},${targetY} ${targetX},${targetY}`
  const markerId = arrowMarkerId(id)

  // Label sits right where the arc departs the spine, not floating at the
  // midpoint of a long loop where it has no visual relationship to either end.
  const labelX = sourceX + (gutterX - sourceX) * 0.35
  const labelY = sourceY

  return (
    <>
      <svg width={0} height={0}>
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX={10}
            refY={5}
            markerWidth={ARROW_SIZE}
            markerHeight={ARROW_SIZE}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} opacity={opacity} />
          </marker>
        </defs>
      </svg>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke: color,
          strokeWidth: kind === 'restartFrom' ? 2 : 1.5,
          strokeDasharray: KIND_DASH[kind],
          opacity,
          transition: 'opacity 120ms ease',
        }}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(6px, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 10,
              fontWeight: 600,
              color,
              background: 'var(--bg-primary)',
              padding: '1px 5px',
              borderRadius: 4,
              border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              opacity,
              transition: 'opacity 120ms ease',
            }}
          >
            {kind === 'restartFrom' ? '↩' : '⇥'} {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
