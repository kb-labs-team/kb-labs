/**
 * CommitFilesTab — file viewer grouped by status with expandable diffs and AI summaries.
 */

import { useState } from 'react';
import { useData, useMutateData, useNotification, useTheme, UICard, UIButton, UIEmptyState, UISkeleton, UIAlert, UITag, UIBadge, UIIcon, UITypographyText, UIDiffViewer } from '@kb-labs/sdk/studio';

const Text = UITypographyText;

interface CommitFilesTabProps {
  scope: string;
}

interface FileEntry {
  path: string;
  status: string;
}

interface StatusGroup {
  key: string;
  label: string;
  color: string;
  tagColor: string;
  iconName: string;
  files: FileEntry[];
}

export function CommitFilesTab({ scope }: CommitFilesTabProps) {
  const notify = useNotification();
  const { semantic } = useTheme();

  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [overallSummary, setOverallSummary] = useState<string | null>(null);
  const [fileSummaries, setFileSummaries] = useState<Record<string, string>>({});
  const [summarizingFile, setSummarizingFile] = useState<string | null>(null);
  const [isSummarizingAll, setIsSummarizingAll] = useState(false);

  const { data: gitStatus, isLoading } = useData<{ rows?: FileEntry[]; summaries?: FileEntry[] }>(
    '/v1/plugins/commit/git-status', { params: { scope }, enabled: !!scope },
  );

  const summarize = useMutateData<{ scope: string; file?: string }, { summary: string }>(
    '/v1/plugins/commit/summarize',
  );

  // Guards
  if (!scope) {return <UIEmptyState description="Select a scope to continue" />;}
  if (isLoading) {return <UICard><UISkeleton active lines={5} /></UICard>;}

  const rawFiles = gitStatus?.rows ?? gitStatus?.summaries ?? [];
  const files: FileEntry[] = rawFiles
    .filter((f): f is FileEntry => typeof f?.path === 'string')
    .map((f) => ({ path: f.path, status: f.status ?? 'modified' }));

  if (files.length === 0) {
    return (
      <UICard style={{ textAlign: 'center', padding: '48px 0' }}>
        <UIIcon name="FileOutlined" style={{ fontSize: 48, color: semantic.disabled, display: 'block', marginBottom: 16 }} />
        <Text type="secondary">No files changed</Text>
      </UICard>
    );
  }

  // Group by status
  const grouped: Record<string, FileEntry[]> = {};
  for (const f of files) {
    (grouped[f.status] ??= []).push(f);
  }

  const groups: StatusGroup[] = [
    { key: 'staged', label: 'Staged', color: semantic.success, tagColor: 'green', iconName: 'CheckCircleOutlined', files: grouped['staged'] ?? [] },
    { key: 'modified', label: 'Modified', color: semantic.warning, tagColor: 'orange', iconName: 'EditOutlined', files: grouped['modified'] ?? [] },
    { key: 'untracked', label: 'Untracked', color: semantic.disabled, tagColor: 'default', iconName: 'PlusOutlined', files: grouped['untracked'] ?? [] },
  ].filter((g) => g.files.length > 0);

  const toggle = <T,>(set: Set<T>, item: T) => {
    const next = new Set(set);
    if (next.has(item)) { next.delete(item); } else { next.add(item); }
    return next;
  };

  const handleSummarizeAll = async () => {
    setIsSummarizingAll(true);
    try {
      const result = await summarize.mutateAsync({ scope });
      setOverallSummary(result.summary);
      notify.success('Summary generated');
    } catch {
      notify.error('Failed to generate summary');
    } finally {
      setIsSummarizingAll(false);
    }
  };

  const handleSummarizeFile = async (file: string) => {
    setSummarizingFile(file);
    try {
      const result = await summarize.mutateAsync({ scope, file });
      setFileSummaries((prev) => ({ ...prev, [file]: result.summary }));
    } catch {
      notify.error(`Failed to summarize ${file}`);
    } finally {
      setSummarizingFile(null);
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <UICard size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: '8px 14px' } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{files.length}</Text> file{files.length !== 1 ? 's' : ''} changed
            </Text>
            <span style={{ fontSize: 13, color: semantic.textTertiary }}>&middot;</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {groups.map((g) => (
                <UITag key={g.key} color={g.tagColor} style={{ margin: 0 }}>{g.label}: {g.files.length}</UITag>
              ))}
            </div>
          </div>
          <UIButton size="small" icon={<UIIcon name="RobotOutlined" />} onClick={handleSummarizeAll} loading={isSummarizingAll}>
            Summarize All
          </UIButton>
        </div>
      </UICard>

      {/* Overall summary */}
      {overallSummary && (
        <UIAlert
          message="AI Summary"
          description={overallSummary}
          variant="info"
          closable
          onClose={() => setOverallSummary(null)}
          style={{ marginBottom: 16, whiteSpace: 'pre-wrap' }}
          icon={<UIIcon name="RobotOutlined" />}
        />
      )}

      {/* File groups */}
      {groups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.key);

        return (
          <div key={group.key} style={{ marginBottom: 16 }}>
            {/* Group header */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `2px solid ${group.color}`, marginBottom: 4 }}
              onClick={() => setCollapsedGroups(toggle(collapsedGroups, group.key))}
            >
              <UIIcon name="RightOutlined" style={{ fontSize: 10, color: semantic.disabled, transform: isCollapsed ? undefined : 'rotate(90deg)', transition: 'transform 0.2s' }} />
              <UIIcon name={group.iconName} style={{ color: group.color }} />
              <Text strong>{group.label}</Text>
              <UIBadge count={group.files.length} style={{ backgroundColor: group.color }} size="small" />
            </div>

            {/* File rows */}
            {!isCollapsed && group.files.map((file) => {
              const isExpanded = expandedFiles.has(file.path);
              const fileSummary = fileSummaries[file.path];
              const isSummarizing = summarizingFile === file.path;

              return (
                <div key={file.path}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', borderBottom: `1px solid ${semantic.borderPrimary}` }}
                    onClick={() => setExpandedFiles(toggle(expandedFiles, file.path))}
                  >
                    <UIIcon name="RightOutlined" style={{ fontSize: 10, color: semantic.disabled, transform: isExpanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.2s' }} />
                    <UIIcon name="FileOutlined" style={{ fontSize: 13, color: semantic.disabled }} />
                    <Text style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }} ellipsis>{file.path}</Text>
                    <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                      <UIButton variant="text" size="small" icon={<UIIcon name="CopyOutlined" />}
                        onClick={() => { navigator.clipboard.writeText(file.path); notify.success('Copied'); }}
                      />
                      <UIButton variant="text" size="small" icon={<UIIcon name="RobotOutlined" />}
                        onClick={() => handleSummarizeFile(file.path)} loading={isSummarizing}
                      />
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ borderBottom: `1px solid ${semantic.borderPrimary}` }}>
                      {fileSummary && (
                        <UIAlert
                          message="AI Summary"
                          description={fileSummary}
                          variant="success"
                          closable
                          onClose={() => setFileSummaries((prev) => { const n = { ...prev }; delete n[file.path]; return n; })}
                          style={{ margin: '8px 12px', whiteSpace: 'pre-wrap' }}
                          icon={<UIIcon name="RobotOutlined" />}
                        />
                      )}
                      <FileDiff scope={scope} file={file.path} status={file.status} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Inline file diff viewer — fetches diff for a single file.
 */
function FileDiff({ scope, file, status }: { scope: string; file: string; status: string }) {
  const { data: diffData, isLoading } = useData<{ diff: string }>(
    '/v1/plugins/commit/diff', { params: { scope, file }, enabled: !!scope && !!file },
  );

  if (isLoading) {return <div style={{ padding: 16 }}><UISkeleton active lines={8} /></div>;}
  if (!diffData?.diff) {return <div style={{ padding: 16 }}><Text type="secondary">No changes to display</Text></div>;}

  const isNew = status === 'untracked' || status === 'added';

  if (isNew) {
    return (
      <div style={{ padding: 16 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>New file content</Text>
        <pre style={{
          margin: 0, maxHeight: 700, overflow: 'auto',
          fontFamily: 'Monaco, Menlo, monospace', fontSize: 12, lineHeight: 1.5,
          padding: 12, borderRadius: 8,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {diffData.diff}
        </pre>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <UIDiffViewer diff={diffData.diff} maxHeight={700} />
    </div>
  );
}
