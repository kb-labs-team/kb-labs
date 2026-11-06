/**
 * CommitPlanTab — commit plan viewer with generate/apply/push/reset actions.
 */

import { useState, useEffect } from 'react';
import { theme } from 'antd';
import {
  useData, useMutateData, useNotification, useTheme, useElapsedTimer,
  UICard, UIButton, UIEmptyState, UISpin, UISkeleton, UIAlert, UITag,
  UITooltip, UIIcon, UISpace, UICheckbox, UIInput, UIDropdown,
  UIPopconfirm, UITypographyText, UIModalConfirm, UIModalError, UIFlex,
  UISkeletonText, UIShimmerText,
} from '@kb-labs/sdk/studio';

const { useToken } = theme;
const Text = UITypographyText;

interface CommitPlanTabProps {
  scope: string;
}

interface Commit {
  id: string;
  type: string;
  scope?: string;
  message: string;
  body?: string;
  files?: string[];
  breaking?: boolean;
  reasoning?: { explanation: string; confidence?: number };
}

interface PlanData {
  plan?: { commits: Commit[] };
}

interface StatusData {
  filesChanged: number;
  hasPlan: boolean;
  planStatus: string;
  branch?: string;
  planStale?: boolean;
  planStaleReason?: string;
}

// Semantic commit type → Ant Design token color name
const TYPE_COLOR_MAP: Record<string, string> = {
  feat: 'green', fix: 'red', docs: 'blue', style: 'purple',
  refactor: 'cyan', test: 'magenta', chore: 'default', perf: 'gold',
  ci: 'blue', build: 'geekblue',
};

const GENERATE_PHRASES = [
  'Analyzing changed files…',
  'Grouping into logical commits…',
  'Writing commit messages…',
  'Checking for secrets…',
];

export function CommitPlanTab({ scope }: CommitPlanTabProps) {
  const { token } = useToken();
  const { semantic } = useTheme();
  const notify = useNotification();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMsg, setEditMsg] = useState('');
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [allowSecrets, setAllowSecrets] = useState(false);
  const [genStartedAt, setGenStartedAt] = useState<string | undefined>(undefined);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [llmAdapterMissing, setLlmAdapterMissing] = useState(false);

  const { data: statusData, isLoading: statusLoading, refetch: refetchStatus } = useData<StatusData>(
    '/v1/plugins/commit/status', { params: { scope }, enabled: !!scope },
  );
  const { data: planData, refetch: refetchPlan } = useData<PlanData>(
    '/v1/plugins/commit/plan', { params: { scope }, enabled: !!scope },
  );

  const refetchAll = () => { void refetchStatus(); void refetchPlan(); };

  const generate = useMutateData<{ scope: string; allowSecrets: boolean; autoConfirm: boolean }, any>('/v1/plugins/commit/generate');
  const apply = useMutateData<{ scope: string; commitIds?: string[] }, any>('/v1/plugins/commit/apply');
  const push = useMutateData<{ scope: string }, any>('/v1/plugins/commit/push');
  const reset = useMutateData<{ scope: string }, any>('/v1/plugins/commit/plan', 'DELETE');
  const patch = useMutateData<{ scope: string; commitId: string; message: string }, any>('/v1/plugins/commit/plan', 'PATCH');
  const regenerate = useMutateData<{ scope: string; commitId: string }, any>('/v1/plugins/commit/regenerate-commit');

  const isGenerating = generate.isLoading;
  const elapsed = useElapsedTimer(genStartedAt);

  useEffect(() => {
    if (!isGenerating) {
      setGenStartedAt(undefined);
      return;
    }
    setGenStartedAt((prev) => prev ?? new Date().toISOString());
    setPhraseIdx(0);
    const id = setInterval(() => setPhraseIdx((i) => (i + 1) % GENERATE_PHRASES.length), 3800);
    return () => clearInterval(id);
  }, [isGenerating]);

  const filesChanged = statusData?.filesChanged ?? 0;
  const commits = planData?.plan?.commits ?? [];
  const hasPlan = commits.length > 0;
  const planStatus = hasPlan ? (statusData?.planStatus ?? 'ready') : 'idle';
  const isAnyLoading = generate.isLoading || apply.isLoading || push.isLoading || reset.isLoading;

  const handleGenerate = () => {
    setLlmAdapterMissing(false);
    if (allowSecrets) {
      UIModalConfirm({
        title: 'Allow Secrets?',
        icon: <UIIcon name="ExclamationCircleOutlined" />,
        content: 'Files may contain secrets. This bypasses security checks.',
        okText: 'Proceed',
        okType: 'danger',
        onOk: () => generate.mutate({ scope, allowSecrets: true, autoConfirm: true }, { onSuccess: refetchAll }),
      });
    } else {
      generate.mutate({ scope, allowSecrets: false, autoConfirm: false }, {
        onSuccess: (data: any) => {
          refetchAll();
          if (data.secretsDetected && data.secrets) {
            UIModalError({
              title: 'Secrets Detected',
              width: 600,
              content: (
                <div>
                  <UIAlert message={data.message} variant="error" showIcon style={{ marginBottom: 16 }} />
                  <Text strong>{data.secrets.length} potential secret(s) found.</Text>
                  <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 8 }}>
                    {data.secrets.map((s: any, i: number) => (
                      <UICard key={i} size="small" style={{ marginBottom: 8 }}>
                        <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.file}:{s.line}</Text>
                        <br />
                        <Text type="secondary">{s.type}: {s.matched}</Text>
                      </UICard>
                    ))}
                  </div>
                </div>
              ),
            });
          }
        },
        onError: (error: Error) => {
          if (/(llm|adapter)/i.test(error.message) && /(not configured|required|unavailable)/i.test(error.message)) {
            setLlmAdapterMissing(true);
            return;
          }
          notify.error(`Plan generation failed: ${error.message}`);
        },
      });
    }
  };

  const handleApply = (commitIds?: string[]) => {
    apply.mutate({ scope, commitIds }, {
      onSuccess: (data: any) => {
        refetchAll();
        const result = data.result;
        const applied = result?.appliedCommits?.length ?? 0;
        const errors: string[] = result?.errors ?? [];
        if (result?.success) {
          notify.success(`${applied} commit(s) applied`);
          setSelected(new Set());
        } else if (applied > 0 && errors.length > 0) {
          notify.warning(`${applied} commit(s) applied, ${errors.length} failed: ${errors[0]}`);
          setSelected(new Set());
        } else {
          notify.error(errors[0] ?? 'Apply failed');
        }
      },
      onError: (e: Error) => notify.error(`Apply failed: ${e.message}`),
    });
  };

  const handlePush = () => {
    push.mutate({ scope }, {
      onSuccess: (data: any) => {
        refetchAll();
        if (data.result?.success) {
          notify.success(`Pushed ${data.result.commitsPushed} commit(s) to ${data.result.remote}/${data.result.branch}`);
          setSelected(new Set());
          setExpanded(new Set());
        } else {
          notify.error(data.result?.error ?? 'Push failed');
        }
      },
      onError: (e: Error) => notify.error(`Push failed: ${e.message}`),
    });
  };

  const handleReset = () => {
    reset.mutate({ scope }, {
      onSuccess: () => { refetchAll(); notify.success('Plan reset'); setSelected(new Set()); setExpanded(new Set()); },
      onError: (e: Error) => notify.error(`Reset failed: ${e.message}`),
    });
  };

  const handleSaveEdit = (commitId: string) => {
    patch.mutate({ scope, commitId, message: editMsg }, {
      onSuccess: () => { refetchPlan(); setEditingId(null); notify.success('Message updated'); },
      onError: (e: Error) => notify.error(`Update failed: ${e.message}`),
    });
  };

  const handleRegenerate = (commitId: string) => {
    setRegeneratingId(commitId);
    regenerate.mutate({ scope, commitId }, {
      onSuccess: () => { refetchPlan(); setRegeneratingId(null); notify.success('Commit regenerated'); },
      onError: (e: Error) => { setRegeneratingId(null); notify.error(`Regenerate failed: ${e.message}`); },
    });
  };

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  };

  if (!scope) {
    return <UIEmptyState description="Select a repository to continue" />;
  }
  if (statusLoading) {
    return <UISkeleton active lines={6} />;
  }

  const statusDot: Record<string, string> = {
    idle: semantic.disabled,
    ready: semantic.info,
    applied: semantic.success,
    pushed: semantic.success,
  };
  const statusLabel: Record<string, string> = {
    idle: 'No plan', ready: 'Ready to apply', applied: 'Applied', pushed: 'Pushed',
  };

  const dot = <span style={{ display: 'flex', alignItems: 'center', fontSize: 13, color: semantic.textTertiary }}>&middot;</span>;

  const isStale = hasPlan && !!statusData?.planStale;
  const pillColor = isStale ? semantic.warning : (statusDot[planStatus] ?? semantic.disabled);
  const pillLabel = isStale ? 'Outdated' : (statusLabel[planStatus] ?? statusLabel.idle);
  const pill = (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
        background: `${pillColor}1F`,
        color: pillColor,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
      {pillLabel}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.marginSM }}>
      {/* Toolbar */}
      <UICard size="small" styles={{ body: { padding: '8px 14px' } }}>
        <UIFlex justify="between" align="center" wrap="wrap" gap={12}>
          <UIFlex align="center" gap={10} style={{ minWidth: 0, flex: '1 1 auto' }}>
            {isStale ? (
              <UITooltip title={statusData?.planStaleReason ?? 'Plan no longer matches the current changes'}>
                {pill}
              </UITooltip>
            ) : pill}
            {hasPlan && (
              <>
                {dot}
                <Text type="secondary" style={{ fontSize: 13 }}>
                  <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{commits.length}</Text> commit{commits.length !== 1 ? 's' : ''}
                </Text>
              </>
            )}
            {dot}
            <Text type="secondary" style={{ fontSize: 13 }}>
              <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{filesChanged}</Text> file{filesChanged !== 1 ? 's' : ''} changed
            </Text>
            {statusData?.branch && (
              <>
                {dot}
                <UITooltip title={statusData.branch}>
                  <span
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 12, fontFamily: 'monospace', color: semantic.textSecondary,
                      maxWidth: 150, minWidth: 0,
                    }}
                  >
                    <UIIcon name="BranchesOutlined" style={{ fontSize: 11, flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusData.branch}</span>
                  </span>
                </UITooltip>
              </>
            )}
          </UIFlex>

          <UISpace size={8} style={{ flexShrink: 0 }}>
            {!hasPlan && (
              <>
                <UICheckbox checked={allowSecrets} onChange={(v) => setAllowSecrets(v)}>
                  <Text type="secondary" style={{ fontSize: 13 }}>Allow secrets</Text>
                </UICheckbox>
                <UIButton variant="primary" size="small" icon={<UIIcon name="ThunderboltOutlined" />} onClick={handleGenerate} loading={generate.isLoading} disabled={filesChanged === 0}>
                  Generate plan
                </UIButton>
              </>
            )}
            {hasPlan && planStatus === 'ready' && (
              selected.size > 0 ? (
                <UIButton variant="primary" size="small" onClick={() => handleApply([...selected])} loading={apply.isLoading} disabled={isAnyLoading}>
                  Apply Selected ({selected.size})
                </UIButton>
              ) : (
                <UIButton variant="primary" size="small" onClick={() => handleApply()} loading={apply.isLoading} disabled={isAnyLoading}>
                  Apply All
                </UIButton>
              )
            )}
            {hasPlan && (planStatus === 'applied' || planStatus === 'pushed') && (
              <UIButton size="small" icon={<UIIcon name="CloudUploadOutlined" />} onClick={handlePush} loading={push.isLoading} disabled={isAnyLoading}>
                Push
              </UIButton>
            )}
            {hasPlan && (
              <>
                <UIButton variant={isStale ? 'primary' : undefined} size="small" icon={<UIIcon name="ReloadOutlined" />} onClick={handleGenerate} loading={generate.isLoading} disabled={isAnyLoading}>
                  Regenerate
                </UIButton>
                <UIPopconfirm title="Reset commit plan?" description="This deletes the current plan." onConfirm={handleReset} okText="Reset" okType="danger">
                  <span>
                    <UIButton size="small" danger icon={<UIIcon name="DeleteOutlined" />} loading={reset.isLoading} disabled={isAnyLoading}>
                      Reset
                    </UIButton>
                  </span>
                </UIPopconfirm>
              </>
            )}
          </UISpace>
        </UIFlex>
      </UICard>

      {/* Generating — skeleton with a rotating status line on top of it */}
      {llmAdapterMissing && (
        <UIAlert
          variant="error"
          showIcon
          message="LLM adapter required"
          description="Commit plan generation needs an LLM adapter. Install and bind one with: kb marketplace install @kb-labs/adapters-openai --scope platform; kb adapter bind llm @kb-labs/adapters-openai"
        />
      )}
      {generate.isLoading && (
        <UICard style={{ padding: '20px 24px' }}>
          <UISkeletonText width={['100%', '85%', '65%']} height="16px" gap={12} />
          <div style={{ textAlign: 'center', paddingTop: 18 }}>
            <UIShimmerText duration="1.8s">{GENERATE_PHRASES[phraseIdx]}</UIShimmerText>
            {elapsed && (
              <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 6 }}>{elapsed} elapsed</div>
            )}
          </div>
        </UICard>
      )}

      {/* Empty state — quiet placeholder, actions already live in the toolbar */}
      {!hasPlan && commits.length === 0 && !generate.isLoading && (
        <div style={{ textAlign: 'center', padding: '28px 0', color: token.colorTextTertiary, fontSize: 13 }}>
          {filesChanged > 0 ? 'No commit plan yet — generate one from the toolbar above.' : 'No changes to commit.'}
        </div>
      )}

      {/* Commit list */}
      {!generate.isLoading && commits.length > 0 && commits.map((commit) => {
        const isExpanded = expanded.has(commit.id);
        const isEditing = editingId === commit.id;
        const isRegenerating = regeneratingId === commit.id;
        const isSelected = selected.has(commit.id);
        const typeColor = TYPE_COLOR_MAP[commit.type] ?? 'default';

        return (
          <UICard key={commit.id} size="small" style={{ opacity: isRegenerating ? 0.6 : 1 }}>
            <UIFlex align="center" gap={8} style={{ marginBottom: isExpanded ? token.marginSM : 0 }}>
              {planStatus === 'ready' && (
                <span onClick={(e) => e.stopPropagation()}>
                  <UICheckbox checked={isSelected} onChange={() => setSelected(toggle(selected, commit.id))} />
                </span>
              )}

              <UIIcon
                name="RightOutlined"
                style={{ fontSize: 11, cursor: 'pointer', color: token.colorTextTertiary, transform: isExpanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.2s' }}
                onClick={() => setExpanded(toggle(expanded, commit.id))}
              />

              <UITag color={typeColor} style={{ margin: 0 }}>{commit.type}</UITag>

              <div style={{ flex: 1, cursor: 'pointer', minWidth: 0 }} onClick={() => setExpanded(toggle(expanded, commit.id))}>
                {isEditing ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                    <UIInput size="small" value={editMsg} onChange={(v) => setEditMsg(v)} onPressEnter={() => handleSaveEdit(commit.id)} autoFocus style={{ flex: 1 }} />
                    <UIButton size="small" variant="text" icon={<UIIcon name="CheckOutlined" />} onClick={() => handleSaveEdit(commit.id)} loading={patch.isLoading} />
                    <UIButton size="small" variant="text" icon={<UIIcon name="CloseOutlined" />} onClick={() => setEditingId(null)} />
                  </div>
                ) : (
                  <Text ellipsis>
                    {commit.scope && <Text type="secondary">({commit.scope}){' '}</Text>}
                    {commit.message}
                  </Text>
                )}
              </div>

              {commit.breaking && <UITag color="red" style={{ margin: 0 }}>BREAKING</UITag>}

              <UITooltip title={`${commit.files?.length ?? 0} files`}>
                <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{commit.files?.length ?? 0} files</Text>
              </UITooltip>

              {commit.reasoning?.confidence !== undefined && (
                <UITooltip title="AI confidence">
                  <Text type="secondary" style={{ fontSize: 12 }}>{(commit.reasoning.confidence * 100).toFixed(0)}%</Text>
                </UITooltip>
              )}

              {planStatus === 'ready' && !isEditing && (
                <UIDropdown trigger={['click']} menu={{
                  items: [
                    { key: 'edit', label: 'Edit message', icon: <UIIcon name="EditOutlined" />, onClick: () => { setEditingId(commit.id); setEditMsg(commit.message); } },
                    { key: 'regen', label: 'Regenerate', icon: <UIIcon name="ReloadOutlined" />, onClick: () => handleRegenerate(commit.id) },
                  ],
                }}>
                  <UIButton variant="text" size="small" icon={<UIIcon name="MoreOutlined" />} onClick={(e) => e.stopPropagation()} />
                </UIDropdown>
              )}
            </UIFlex>

            {isExpanded && (
              <div style={{ paddingTop: token.paddingSM, fontSize: 13 }}>
                {isRegenerating && (
                  <UIFlex justify="center" style={{ padding: token.paddingSM }}>
                    <UISpin size="small" />
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 13 }}>Regenerating...</Text>
                  </UIFlex>
                )}
                {commit.body && (
                  <Text type="secondary" style={{ whiteSpace: 'pre-wrap', display: 'block', fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>
                    {commit.body}
                  </Text>
                )}
                {commit.files && commit.files.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                      {commit.files.length} file{commit.files.length !== 1 ? 's' : ''}
                    </Text>
                    <div style={{ background: token.colorFillAlter, borderRadius: token.borderRadiusSM, padding: '6px 10px' }}>
                      {commit.files.map((file, i) => (
                        <div key={i} style={{ padding: '2px 0', fontFamily: 'monospace', fontSize: 12 }}>{file}</div>
                      ))}
                    </div>
                  </div>
                )}
                {commit.reasoning && (
                  <div style={{ borderLeft: `2px solid ${semantic.info}`, padding: '2px 10px', fontSize: 12 }}>
                    <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
                      {commit.reasoning.explanation}
                      {commit.reasoning.confidence !== undefined && (
                        <> &middot; {(commit.reasoning.confidence * 100).toFixed(0)}% confidence</>
                      )}
                    </Text>
                  </div>
                )}
              </div>
            )}
          </UICard>
        );
      })}
    </div>
  );
}
