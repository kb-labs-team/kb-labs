import { UITag } from '@kb-labs/studio-ui-kit';
import styles from './artifacts.module.css'

interface Issue {
  file?: string
  line?: number
  severity?: string
  message?: string
  problem?: string
  fix?: string
}

const SEVERITY_COLOR: Record<string, string> = {
  blocker: 'error',
  high: 'error',
  medium: 'warning',
  low: 'default',
  info: 'processing',
}

export function IssuesViewer({ data }: { data: unknown }) {
  const issues = Array.isArray(data) ? (data as Issue[]) : []

  if (!issues.length) {
    return <div className={styles.empty}>No issues found.</div>
  }

  return (
    <div className={styles.issueList}>
      {issues.map((issue, i) => {
        const severity = issue.severity ?? 'info'
        const color = SEVERITY_COLOR[severity] ?? 'default'
        return (
          <div key={i} className={styles.issueItem}>
            <div className={styles.issueHeader}>
              <UITag color={color}>{severity}</UITag>
              {issue.file && (
                <span className={styles.issueFile}>
                  {issue.file}{issue.line ? `:${issue.line}` : ''}
                </span>
              )}
            </div>
            <div className={styles.issueMessage}>
              {issue.message ?? issue.problem ?? JSON.stringify(issue)}
            </div>
            {issue.fix && (
              <div className={styles.issueFix}>Fix: {issue.fix}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
