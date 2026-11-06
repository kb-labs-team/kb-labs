import React, { useState, useEffect } from 'react';
import { theme } from 'antd';
import type { Turn, TurnStep, FileChangeSummary, ToolUseStep } from '../../contracts/index.js';
import {
  useMutateData,
  useData,
  UISpin,
  UISkeleton,
  UIMarkdownViewer,
  UIModalConfirm,
  UITag,
  UITypographyText,
  UIFlex,
  UIIcon,
  UIButton,
} from '@kb-labs/sdk/studio';

const { useToken } = theme;

type Token = ReturnType<typeof useToken>['token'];

interface ConversationViewProps {
  turns: Turn[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  sessionId?: string | null;
}

export function ConversationView({ turns, isLoading, isError, onRetry, sessionId }: ConversationViewProps) {
  const { token } = useToken();

  if (isLoading) {
    return (
      <UISkeleton active lines={5} style={{ minHeight: 240 }} />
    );
  }

  if (isError) {
    return (
      <div style={{ minHeight: 240, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <UIIcon name="DisconnectOutlined" style={{ fontSize: 24, color: token.colorTextTertiary }} />
        <UITypographyText type="secondary">Failed to load history</UITypographyText>
        {onRetry && <UIButton size="small" onClick={onRetry}>Retry</UIButton>}
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, gap: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%',
          background: token.colorFillTertiary,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <UIIcon name="RobotOutlined" style={{ fontSize: 18, color: token.colorTextSecondary }} />
        </div>
        <UITypographyText style={{ fontSize: 15, fontWeight: 500 }}>What are we working on?</UITypographyText>
        <UITypographyText type="secondary" style={{ fontSize: 13 }}>Ask anything to get started</UITypographyText>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '16px 16px 40px', gap: 24 }}>
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} sessionId={sessionId} token={token} />
      ))}
    </div>
  );
}

// ---------- TurnView ----------

function TurnView({ turn, sessionId, token }: { turn: Turn; sessionId?: string | null; token: Token }) {
  if (turn.type === 'user') {
    const text = turn.steps.find((s) => s.type === 'text');
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <span style={{
          maxWidth: '70%',
          background: token.colorFillTertiary,
          borderRadius: token.borderRadiusLG,
          padding: '9px 14px',
          fontSize: 14,
          lineHeight: 1.55,
          color: token.colorText,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {text?.type === 'text' ? text.content : ''}
        </span>
      </div>
    );
  }

  const isStreaming = turn.status === 'streaming';

  const textSteps = turn.steps.filter((s) => s.type === 'text');
  const visibleTextSteps = textSteps.filter(
    (s) => !isInternalProgressText(s.content ?? '') && s.content?.trim(),
  );

  const reportStep = turn.steps.find(
    (s) => s.type === 'tool_use' && (s as ToolUseStep).toolName === 'report',
  ) as ToolUseStep | undefined;
  const reportAnswer = (reportStep?.input as Record<string, unknown> | null)?.answer as string | undefined;

  const actionSteps = turn.steps.filter(
    (s) => s.type !== 'text' && !(s.type === 'tool_use' && (s as ToolUseStep).toolName === 'report'),
  );

  const hasActions = actionSteps.length > 0;
  const showThinkingLoader = isStreaming && actionSteps.length === 0
    && textSteps.every((s) => isInternalProgressText(s.content ?? ''));
  const answerContent = reportAnswer ?? null;
  const fileChanges = turn.metadata?.fileChanges;
  const runId = turn.metadata?.runId;
  const showFileChanges = !isStreaming && fileChanges && fileChanges.length > 0 && !!sessionId && !!runId;

  const sectionStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
  };

  const statusLabel = isStreaming ? 'Running' : turn.status === 'failed' ? 'Failed' : null;
  const statusColor = isStreaming ? token.colorPrimary : token.colorError;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Assistant header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <UITypographyText type="secondary" style={{ fontSize: 12, fontWeight: 500 }}>Agent</UITypographyText>
        <UITypographyText type="secondary" style={{ fontSize: 11 }}>· {formatRelativeTime(turn.startedAt)}</UITypographyText>
        {statusLabel && (
          <UITypographyText style={{ fontSize: 11, color: statusColor }}>· {statusLabel}</UITypographyText>
        )}
      </div>

      {/* Actions group */}
      {hasActions && (
        <div style={sectionStyle}>
          <ToolGroup steps={actionSteps} isStreaming={isStreaming} token={token} />
        </div>
      )}
      {!hasActions && showThinkingLoader && <ThinkingRow token={token} />}

      {/* Final answer */}
      {answerContent && (
        <div style={sectionStyle}>
          <UIMarkdownViewer content={answerContent} style={{ padding: 0 }} />
        </div>
      )}
      {!answerContent && visibleTextSteps.map((step) => (
        step.type === 'text' && step.content?.trim() ? (
          <div key={step.id} style={sectionStyle}>
            <UIMarkdownViewer content={step.content} style={{ padding: 0 }} />
          </div>
        ) : null
      ))}

      {/* File changes */}
      {showFileChanges && (
        <div style={sectionStyle}>
          <FileChangesBlock
            sessionId={sessionId!}
            runId={runId!}
            fileChanges={fileChanges!}
            token={token}
          />
        </div>
      )}
    </div>
  );
}

// ---------- ToolGroup ----------

function summarizeTools(steps: TurnStep[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of steps) {
    if (s.type === 'tool_use') {
      const name = formatToolName((s as ToolUseStep).toolName);
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

function ToolGroup({ steps, isStreaming, token }: { steps: TurnStep[]; isStreaming: boolean; token: Token }) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) { setOpen(true); }
  }, [isStreaming]);

  const toolCounts = summarizeTools(steps);
  const summaryParts = Object.entries(toolCounts).map(([k, v]) => v > 1 ? `${k} ×${v}` : k);
  const totalDurationMs = steps.reduce(
    (s, t) => s + (t.type === 'tool_use' ? ((t as ToolUseStep).durationMs ?? 0) : 0),
    0,
  );

  const toggleStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: 'none',
    border: 'none',
    padding: '2px 0',
    cursor: 'pointer',
    fontSize: 12,
    color: token.colorTextSecondary,
    fontFamily: 'inherit',
  };

  return (
    <div>
      <button style={toggleStyle} onClick={() => setOpen((v) => !v)}>
        <UIIcon
          name={open ? 'DownOutlined' : 'RightOutlined'}
          style={{ fontSize: 9, color: token.colorTextTertiary }}
        />
        {isStreaming
          ? <UIIcon name="LoadingOutlined" style={{ fontSize: 11, color: token.colorTextTertiary }} />
          : null}
        <span style={{ fontWeight: 500, color: token.colorText }}>
          {steps.length} {steps.length === 1 ? 'action' : 'actions'}
        </span>
        {!open && summaryParts.length > 0 && (
          <span style={{ color: token.colorTextTertiary }}>— {summaryParts.join('  ')}</span>
        )}
        {!open && totalDurationMs > 0 && (
          <span style={{ color: token.colorTextTertiary }}>· {(totalDurationMs / 1000).toFixed(1)}s</span>
        )}
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
          {steps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              isLast={false}
              isStreaming={isStreaming && i === steps.length - 1}
              token={token}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- ThinkingRow ----------

const THINKING_WORDS = [
  'Thinking', 'Pondering', 'Reasoning', 'Mulling', 'Puzzling',
  'Cogitating', 'Percolating', 'Ruminating', 'Noodling', 'Working',
];

function ThinkingRow({ token }: { token: Token }) {
  const [word, setWord] = useState(
    () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)],
  );

  useEffect(() => {
    const id = setInterval(() => {
      setWord((prev) => {
        const options = THINKING_WORDS.filter((w) => w !== prev);
        return options[Math.floor(Math.random() * options.length)];
      });
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <UIIcon name="LoadingOutlined" style={{ fontSize: 11, color: token.colorTextTertiary }} />
      <UITypographyText type="secondary" style={{ fontSize: 13 }}>{word}...</UITypographyText>
    </div>
  );
}

// ---------- StepRow ----------

function StepRow({ step, isStreaming, token }: { step: TurnStep; isLast: boolean; isStreaming: boolean; token: Token }) {
  switch (step.type) {
    case 'thinking': {
      const content = step.content?.trim() ?? '';
      if (isNoisyThinking(content)) { return null; }
      return (
        <UIMarkdownViewer content={content} style={{ fontSize: 13, color: token.colorTextSecondary, padding: 0 }} />
      );
    }

    case 'tool_use':
      return <ToolRow step={step} isStreaming={isStreaming} token={token} />;

    case 'tool_result':
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <UIIcon
            name={step.success ? 'CheckCircleOutlined' : 'CloseCircleOutlined'}
            style={{ fontSize: 13, marginTop: 2, color: step.success ? token.colorSuccess : token.colorError }}
          />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, color: token.colorTextSecondary }}>
              <span style={{ fontWeight: 500, color: token.colorText }}>{formatToolName(step.toolName)}</span>
              {step.durationMs !== undefined && (
                <span style={{ marginLeft: 6, fontSize: 11, color: token.colorTextTertiary }}>{step.durationMs}ms</span>
              )}
            </span>
            {!step.success && step.error && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: token.colorError }}>{step.error}</p>
            )}
          </div>
        </div>
      );

    case 'subagent':
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <UIIcon name="RobotOutlined" style={{ fontSize: 13, marginTop: 2, color: token.colorPrimary }} />
          <span style={{ fontSize: 13, color: token.colorTextSecondary }}>
            <span style={{ fontWeight: 500, color: token.colorText }}>Agent: {step.agentName}</span>
            <span style={{ marginLeft: 6 }}>— {step.task?.slice(0, 60)}{(step.task?.length ?? 0) > 60 ? '...' : ''}</span>
          </span>
        </div>
      );

    case 'error':
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <UIIcon name="ExclamationCircleOutlined" style={{ fontSize: 13, marginTop: 2, color: token.colorError }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: token.colorError }}>{step.code}</span>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: token.colorError }}>{step.message}</p>
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ---------- ToolRow ----------

function ToolRow({ step, isStreaming, token }: { step: ToolUseStep; isStreaming: boolean; token: Token }) {
  const [open, setOpen] = useState(false);

  const isPending = step.status === 'pending';
  const isDone = step.status === 'done';
  const isError = step.status === 'error';
  const isFailed = isDone && step.success === false;

  const meta = getToolMeta(step);
  const hasDiff = isDone && !!step.metadata?.diff;
  const hasOutput = isDone && step.output != null;
  const input = step.input as Record<string, unknown> | null | undefined;
  const isWriteTool = /write|patch|edit/i.test(step.toolName);
  const hasWriteInput = isWriteTool && isDone && !!(input?.content ?? input?.new_content);
  const canExpand = hasOutput || hasDiff || hasWriteInput || isError;

  const iconColor = isPending
    ? (isStreaming ? token.colorTextTertiary : token.colorPrimary)
    : (isDone && !isFailed ? token.colorSuccess : token.colorError);

  const m = step.metadata;
  const todoList = (isDone && m?.uiHint === 'todo' && m.structured != null)
    ? (m.structured as Record<string, unknown>).todoList as TodoListData | undefined
    : undefined;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <UIIcon
        name={isPending && isStreaming ? 'LoadingOutlined' : toolIconName(step.toolName)}
        style={{ fontSize: 13, marginTop: 2, color: iconColor, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          onClick={() => canExpand && setOpen((v) => !v)}
          disabled={!canExpand}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: canExpand ? 'pointer' : 'default',
            fontSize: 13,
            color: token.colorText,
            flexWrap: 'wrap',
            fontFamily: 'inherit',
          }}
        >
          <span style={{ fontWeight: 500 }}>{formatToolName(step.toolName)}</span>
          {meta.badge && (
            <span style={{ fontSize: 11, color: token.colorTextSecondary, background: token.colorFillSecondary, borderRadius: token.borderRadiusSM, padding: '0 5px' }}>
              {meta.badge}
            </span>
          )}
          {isDone && m?.resultCount !== undefined && (
            <span style={{ fontSize: 11, color: token.colorTextSecondary, background: token.colorFillSecondary, borderRadius: token.borderRadiusSM, padding: '0 5px' }}>
              {m.resultCount} results
            </span>
          )}
          {isDone && m?.exitCode !== undefined && m.exitCode !== 0 && (
            <span style={{ fontSize: 11, color: token.colorError, background: token.colorErrorBg, borderRadius: token.borderRadiusSM, padding: '0 5px' }}>
              exit {m.exitCode}
            </span>
          )}
          {isDone && (m?.linesAdded !== undefined || m?.linesRemoved !== undefined) && (
            <span style={{ fontSize: 11, color: token.colorSuccess, background: token.colorSuccessBg, borderRadius: token.borderRadiusSM, padding: '0 5px' }}>
              {m?.linesAdded != null && m.linesAdded > 0 ? `+${m.linesAdded}` : ''}
              {m?.linesRemoved != null && m.linesRemoved > 0 ? ` -${m.linesRemoved}` : ''}
            </span>
          )}
          {!isPending && step.durationMs !== undefined && (
            <span style={{ fontSize: 11, color: token.colorTextTertiary }}>{step.durationMs}ms</span>
          )}
          {canExpand && (
            <UIIcon name={open ? 'UpOutlined' : 'DownOutlined'} style={{ fontSize: 9, color: token.colorTextTertiary }} />
          )}
        </button>

        {meta.summary && (
          <p style={{ margin: '2px 0 0', fontSize: 12, color: token.colorTextSecondary }}>
            {meta.filePath
              ? <CopyPath path={meta.filePath} label={meta.summary} token={token} />
              : meta.summary}
          </p>
        )}

        {todoList != null && <TodoView todoList={todoList} token={token} />}

        {isError && step.error && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: token.colorError }}>{step.error}</p>
        )}
        {isFailed && !open && step.output != null && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: token.colorError }}>{String(step.output)}</p>
        )}

        {open && (
          <div style={{ marginTop: 6 }}>
            <ToolDetails step={step} hasDiff={hasDiff} hasOutput={hasOutput} token={token} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- ToolDetails ----------

function ToolDetails({ step, hasDiff, hasOutput, token }: { step: ToolUseStep; hasDiff: boolean; hasOutput: boolean; token: Token }) {
  const input = step.input as Record<string, unknown> | null | undefined;
  const toolLower = step.toolName.toLowerCase();

  const isWrite = toolLower.includes('write') || toolLower.includes('patch') || toolLower.includes('edit');
  const isRead = toolLower.includes('read');
  const isShell = toolLower.includes('bash') || toolLower.includes('exec') || toolLower.includes('shell') || toolLower.includes('run');
  const isSearch = toolLower.includes('grep') || toolLower.includes('search') || toolLower.includes('glob') || toolLower.includes('list') || toolLower.includes('rag');

  const codePreStyle: React.CSSProperties = {
    margin: 0,
    padding: '8px 10px',
    fontSize: 12,
    lineHeight: 1.5,
    borderRadius: token.borderRadius,
    overflow: 'auto',
    maxHeight: 300,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  };

  if (isWrite) {
    if (hasDiff) { return <DiffView diff={step.metadata!.diff!} token={token} />; }
    const content = (input?.content ?? input?.new_content ?? input?.text) as string | undefined;
    if (content) {
      const filePath = (input?.path ?? input?.filePath ?? input?.file_path ?? input?.file) as string | undefined;
      const ext = filePath ? filePath.split('.').pop() : undefined;
      return (
        <div>
          {filePath && (
            <div style={{ fontSize: 11, color: token.colorTextTertiary, padding: '3px 8px', background: token.colorFillSecondary, borderRadius: `${token.borderRadius}px ${token.borderRadius}px 0 0` }}>
              {filePath}
            </div>
          )}
          <pre
            style={{ ...codePreStyle, background: token.colorFillSecondary, borderRadius: filePath ? `0 0 ${token.borderRadius}px ${token.borderRadius}px` : token.borderRadius }}
            className={ext ? `lang-${ext}` : undefined}
          >{String(content)}</pre>
        </div>
      );
    }
    return null;
  }

  if (isRead && hasOutput) {
    return <pre style={{ ...codePreStyle, background: token.colorFillSecondary }}>{formatOutput(step.output)}</pre>;
  }
  if (isShell && hasOutput) {
    return <pre style={{ ...codePreStyle, background: token.colorBgSpotlight, color: token.colorTextLightSolid }}>{formatOutput(step.output)}</pre>;
  }
  if (isSearch && hasOutput) {
    return <pre style={{ ...codePreStyle, background: token.colorFillSecondary }}>{formatOutput(step.output)}</pre>;
  }

  if (hasDiff) { return <DiffView diff={step.metadata!.diff!} token={token} />; }
  if (hasOutput) {
    const isFailed = step.status === 'done' && step.success === false;
    const outputStr = formatOutput(step.output);
    if (isFailed) {
      return <pre style={{ ...codePreStyle, background: token.colorErrorBg, color: token.colorError }}>{outputStr}</pre>;
    }
    return <UIMarkdownViewer content={outputStr} style={{ fontSize: 12, padding: 0 }} />;
  }
  return null;
}

// ---------- DiffView ----------

function DiffView({ diff, token }: { diff: string; token: Token }) {
  const lines = diff.split('\n');
  return (
    <pre style={{
      margin: 0, padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
      borderRadius: token.borderRadius, overflow: 'auto', maxHeight: 300,
      background: token.colorFillSecondary, whiteSpace: 'pre',
    }}>
      {lines.map((line, i) => {
        const color =
          line.startsWith('+') && !line.startsWith('+++') ? token.colorSuccess :
          line.startsWith('-') && !line.startsWith('---') ? token.colorError :
          line.startsWith('@@') ? token.colorInfo :
          undefined;
        return <span key={i} style={color ? { color } : undefined}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

// ---------- CopyPath ----------

function CopyPath({ path, label, token }: { path: string; label: string; token: Token }) {
  const [copied, setCopied] = useState(false);
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span
      onClick={handleClick}
      title={path}
      style={{ cursor: 'pointer', color: copied ? token.colorSuccess : token.colorTextSecondary, fontFamily: 'monospace', fontSize: 12 }}
    >
      {label}{copied ? ' ✓' : ''}
    </span>
  );
}

// ---------- FileChangesBlock ----------

interface FileChangesBlockProps {
  sessionId: string;
  runId: string;
  fileChanges: FileChangeSummary[];
  token: Token;
}

function FileChangesBlock({ sessionId, runId, fileChanges, token }: FileChangesBlockProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const rollback = useMutateData<{ runId?: string; changeIds?: string[] }, { rolledBack: number; skipped: number; conflicts: unknown[] }>(
    `/v1/plugins/agents/sessions/${sessionId}/rollback`, 'POST',
  );
  const approve = useMutateData<{ runId?: string; changeIds?: string[] }, { approved: number }>(
    `/v1/plugins/agents/sessions/${sessionId}/approve`, 'POST',
  );

  const visible = fileChanges.filter((c) => !dismissed.has(c.changeId) && !c.approved);
  if (visible.length === 0) { return null; }

  const handleRollback = () => {
    UIModalConfirm({
      title: 'Rollback changes?',
      content: `This will revert ${visible.length} ${pluralFiles(visible.length)} to the state before the agent run.`,
      okText: 'Rollback',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const result = await rollback.mutateAsync({ runId });
          if (result.conflicts?.length) {
            console.warn(`Rolled back: ${result.rolledBack}, skipped: ${result.skipped}`);
          }
          setDismissed(new Set(visible.map((c) => c.changeId)));
        } catch {
          console.error('Failed to rollback changes');
        }
      },
    });
  };

  const handleApprove = async () => {
    try {
      await approve.mutateAsync({ runId });
      setDismissed(new Set(visible.map((c) => c.changeId)));
    } catch {
      console.error('Failed to approve changes');
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <UIIcon name="FileOutlined" style={{ fontSize: 13, marginTop: 2, color: token.colorSuccess }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <UITypographyText style={{ fontSize: 13, fontWeight: 500 }}>
            {visible.length} {pluralFiles(visible.length)} changed
          </UITypographyText>
          <UIFlex gap={4}>
            <button
              onClick={() => void handleApprove()}
              disabled={approve.isLoading || rollback.isLoading}
              title="Approve all"
              style={{ background: token.colorSuccessBg, border: `1px solid ${token.colorSuccessBorder}`, color: token.colorSuccess, borderRadius: token.borderRadius, padding: '2px 8px', fontSize: 12, cursor: 'pointer' }}
            >✓</button>
            <button
              onClick={handleRollback}
              disabled={rollback.isLoading || approve.isLoading}
              title="Rollback all"
              style={{ background: token.colorErrorBg, border: `1px solid ${token.colorErrorBorder}`, color: token.colorError, borderRadius: token.borderRadius, padding: '2px 8px', fontSize: 12, cursor: 'pointer' }}
            >✕</button>
          </UIFlex>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {visible.map((change) => (
            <FileChangeRow
              key={change.changeId}
              change={change}
              sessionId={sessionId}
              onDismiss={() => setDismissed((prev) => new Set([...prev, change.changeId]))}
              token={token}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------- FileChangeRow ----------

interface FileChangeRowProps {
  change: FileChangeSummary;
  sessionId: string;
  onDismiss: () => void;
  token: Token;
}

function FileChangeRow({ change, sessionId, onDismiss, token }: FileChangeRowProps) {
  const [open, setOpen] = useState(false);
  const rollback = useMutateData<{ changeIds: string[] }, { rolledBack: number; skipped: number; conflicts: unknown[] }>(
    `/v1/plugins/agents/sessions/${sessionId}/rollback`, 'POST',
  );
  const approve = useMutateData<{ changeIds: string[] }, { approved: number }>(
    `/v1/plugins/agents/sessions/${sessionId}/approve`, 'POST',
  );

  const diffUrl = open ? `/v1/plugins/agents/sessions/${sessionId}/changes/${encodeURIComponent(change.changeId)}/diff` : '';
  const { data: diffData, isLoading: diffLoading, isError: diffError } = useData<{ diff: string }>(diffUrl, { enabled: open });

  const handleRollback = (e: React.MouseEvent) => {
    e.stopPropagation();
    UIModalConfirm({
      title: 'Rollback file?',
      content: change.filePath,
      okText: 'Rollback',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await rollback.mutateAsync({ changeIds: [change.changeId] });
          onDismiss();
        } catch {
          console.error('Failed to rollback file');
        }
      },
    });
  };

  const handleApprove = (e: React.MouseEvent) => {
    e.stopPropagation();
    approve.mutateAsync({ changeIds: [change.changeId] }).then(onDismiss).catch(() => {
      console.error('Failed to approve file');
    });
  };

  const opTag = change.isNew
    ? <UITag color="success">new</UITag>
    : change.operation === 'delete'
    ? <UITag color="error">del</UITag>
    : <UITag color="blue">mod</UITag>;

  return (
    <li>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, cursor: 'pointer', padding: '2px 4px',
          borderRadius: token.borderRadiusSM,
          background: open ? token.colorFillSecondary : 'transparent',
        }}
      >
        {opTag}
        <span style={{ flex: 1, fontFamily: 'monospace', color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {change.filePath.split('/').pop() ?? change.filePath}
        </span>
        <span style={{ color: token.colorTextTertiary, fontFamily: 'monospace', fontSize: 11 }}>
          {change.filePath.includes('/') ? change.filePath.slice(0, change.filePath.lastIndexOf('/')) : ''}
        </span>
        {!change.approved && (
          <div style={{ display: 'flex', gap: 4 }} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <button onClick={handleApprove} disabled={approve.isLoading} title="Approve"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: token.colorSuccess, fontSize: 13, padding: '0 2px' }}>✓</button>
            <button onClick={handleRollback} disabled={rollback.isLoading} title="Rollback"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: token.colorError, fontSize: 13, padding: '0 2px' }}>✕</button>
          </div>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 4, marginLeft: 4 }}>
          {diffLoading && <UISpin size="small" />}
          {diffData?.diff && <DiffView diff={diffData.diff} token={token} />}
          {diffError && <span style={{ color: token.colorError, fontSize: 12 }}>Failed to load diff</span>}
        </div>
      )}
    </li>
  );
}

// ---------- TodoView ----------

interface TodoItemData {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
}

interface TodoListData {
  sessionId: string;
  items: TodoItemData[];
}

const TODO_STATUS_ICON: Record<string, string> = {
  completed: '✓',
  'in-progress': '●',
  blocked: '✕',
  pending: '○',
};

function TodoView({ todoList, token }: { todoList?: TodoListData; token: Token }) {
  if (!todoList?.items?.length) { return null; }
  const completed = todoList.items.filter((i) => i.status === 'completed').length;
  return (
    <div style={{ marginTop: 6, background: token.colorFillTertiary, borderRadius: token.borderRadius, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 6, fontWeight: 500 }}>
        {completed}/{todoList.items.length}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {todoList.items.map((item) => (
          <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: 1.5, padding: '2px 0' }}>
            <span style={{ fontSize: 12, flexShrink: 0, width: 14, textAlign: 'center', lineHeight: 1 }}>
              {TODO_STATUS_ICON[item.status] ?? '○'}
            </span>
            {item.status === 'completed' ? (
              <UITypographyText type="success" style={{ flex: 1, minWidth: 0, textDecoration: 'line-through' }}>{item.description}</UITypographyText>
            ) : item.status === 'pending' || item.status === 'blocked' ? (
              <UITypographyText type="secondary" style={{ flex: 1, minWidth: 0 }}>{item.description}</UITypographyText>
            ) : (
              <UITypographyText style={{ flex: 1, minWidth: 0 }}>{item.description}</UITypographyText>
            )}
            {item.priority !== 'medium' && (
              <UITypographyText type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>{item.priority}</UITypographyText>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Helpers ----------

interface ToolMeta {
  summary?: string;
  filePath?: string;
  badge?: string;
}

function toolIconName(toolName: string): string {
  const n = toolName.toLowerCase();
  if (/read|open/.test(n)) { return 'FileTextOutlined'; }
  if (/write|patch|edit/.test(n)) { return 'EditOutlined'; }
  if (/bash|exec|shell|run/.test(n)) { return 'CodeOutlined'; }
  if (/grep|search|glob|find/.test(n)) { return 'SearchOutlined'; }
  if (/todo/.test(n)) { return 'CheckSquareOutlined'; }
  if (/rag|mind|embed/.test(n)) { return 'BulbOutlined'; }
  if (/agent|subagent/.test(n)) { return 'RobotOutlined'; }
  if (/delete|remove/.test(n)) { return 'DeleteOutlined'; }
  return 'ApiOutlined';
}

function getToolMeta(step: ToolUseStep): ToolMeta {
  const input = step.input as Record<string, unknown> | null | undefined;
  if (!input) { return {}; }

  const toolLower = step.toolName.toLowerCase();
  const isRead = toolLower.includes('read');
  const isWrite = toolLower.includes('write') || toolLower.includes('patch') || toolLower.includes('edit');

  const path = (input.path ?? input.filePath ?? input.file_path ?? input.file) as string | undefined;
  if (path) {
    const fileName = String(path).split('/').pop() ?? String(path);
    let badge: string | undefined;
    if (isRead) {
      const offset = input.offset ?? input.startLine ?? input.start_line;
      const limit = input.limit ?? input.endLine ?? input.end_line;
      if (offset !== undefined && limit !== undefined) { badge = `${offset}-${Number(offset) + Number(limit)}`; }
      else if (limit !== undefined) { badge = `${limit} lines`; }
    }
    return { summary: fileName, filePath: String(path), badge };
  }

  const query = (input.query ?? input.text ?? input.pattern ?? input.search) as string | undefined;
  if (query) { return { summary: String(query).slice(0, 100) }; }

  const command = (input.command ?? input.cmd) as string | undefined;
  if (command) { return { summary: String(command).slice(0, 100) }; }

  if (isWrite) { return {}; }

  const content = (input.content ?? input.message) as string | undefined;
  if (content) { return { summary: String(content).slice(0, 100) }; }

  return {};
}

function formatToolName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[_-]/g, ' ');
  if (normalized.includes('fs read') || normalized.includes('read file')) { return 'Read'; }
  if (normalized.includes('fs write') || normalized.includes('write file')) { return 'Write'; }
  if (normalized.includes('fs patch') || normalized.includes('patch file')) { return 'Edit'; }
  if (normalized.includes('fs edit') || normalized.includes('edit file')) { return 'Edit'; }
  if (normalized.includes('fs delete') || normalized.includes('delete file') || normalized.includes('remove file')) { return 'Delete'; }
  if (normalized.includes('fs list') || normalized.includes('list files') || normalized.includes('glob')) { return 'Glob'; }
  if (normalized.includes('grep') || normalized.includes('search content')) { return 'Grep'; }
  if (normalized.includes('bash') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('run command')) { return 'Bash'; }
  if (normalized.includes('rag') || normalized.includes('mind')) { return 'Mind'; }
  if (normalized.includes('todo')) { return 'TodoWrite'; }

  const colonIdx = name.indexOf(':');
  const base = colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
  return base
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) { return 'just now'; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  if (diffHours < 24) { return `${diffHours}h ago`; }
  if (diffDays < 7) { return `${diffDays}d ago`; }
  return date.toLocaleDateString();
}

function isNoisyThinking(content: string): boolean {
  const t = content.trim().toLowerCase();
  if (t === '[executing tools...]' || t === '[thinking...]' || t === '[planning...]' || t === '[analyzing...]') { return true; }
  if (t === 'analyzing context and choosing the next step.') { return true; }
  if (t.startsWith('checking facts with tool:') || t.startsWith('running step with tool:') || t.startsWith('running the next step')) { return true; }
  if (t === 'done.' || t === 'ok.' || t === 'done' || t === 'ok') { return true; }
  return false;
}

function isInternalProgressText(content: string): boolean {
  return isNoisyThinking(content);
}

function pluralFiles(n: number): string {
  return n === 1 ? 'file' : 'files';
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') { return output.slice(0, 2000); }
  try { return JSON.stringify(output, null, 2).slice(0, 2000); }
  catch { return String(output).slice(0, 2000); }
}
