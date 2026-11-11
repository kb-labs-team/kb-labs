/**
 * Polymorphic artifact viewer.
 * Routes to the appropriate sub-component based on artifact type.
 * Wrapped in an ErrorBoundary so a broken artifact never crashes the page.
 */

import { Component } from 'react'
import type { ReactNode } from 'react'
import { UIJsonViewer } from '@kb-labs/studio-ui-kit';
import { MarkdownViewer } from './MarkdownViewer'
import { IssuesViewer } from './IssuesViewer'
import { TableViewer } from './TableViewer'
import { DiffViewer } from './DiffViewer'
import { LogViewer } from './LogViewer'
import { LinkViewer } from './LinkViewer'

export interface ArtifactViewerProps {
  type: 'markdown' | 'issues' | 'table' | 'diff' | 'log' | 'json' | 'link'
  data: unknown
  label?: string
  editable?: boolean
  onEdit?: (newValue: unknown) => void
}

class ArtifactErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  override state = { error: null as Error | null };
   
  static getDerivedStateFromError(error: Error): any { return { error }; }
  override render() {
    if (this.state.error) {
      return (
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12, fontStyle: 'italic' }}>
          {this.props.label ?? 'Artifact'}: render error
        </span>
      )
    }
    return this.props.children
  }
}

function ArtifactViewerInner({ type, data, label, editable, onEdit }: ArtifactViewerProps) {
  if (data == null) {return null}
  if (type === 'link') {return <LinkViewer data={data} label={label} />}
  if (type === 'markdown') {return <MarkdownViewer data={data} editable={editable} onEdit={onEdit} />}
  if (type === 'issues') {return <IssuesViewer data={data} />}
  if (type === 'table') {return <TableViewer data={data} />}
  if (type === 'diff') {return <DiffViewer data={data} />}
  if (type === 'log') {return <LogViewer data={data} />}
  if (type === 'json') {return <UIJsonViewer data={data} />}
  return null
}

export function ArtifactViewer(props: ArtifactViewerProps) {
  return (
    <ArtifactErrorBoundary label={props.label}>
      <ArtifactViewerInner {...props} />
    </ArtifactErrorBoundary>
  )
}
