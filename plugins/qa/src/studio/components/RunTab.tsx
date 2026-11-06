import * as React from 'react';
import {
  UIRow, UICol, UICard, UIButton, UITag, UIAlert,
  UISpace, UIIcon, UIDivider, UITable, UIProgress, UIBadge, UISkeleton,
  useMutateData, useData, useTheme, useNotification,
} from '@kb-labs/sdk/studio';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';
import type { DevkitRunOutput, DevkitCheckOutput, DevkitGateOutput } from '../../contracts/index.js';

type TasksResponse = { tasks: string[]; defaultTasks: string[] | null };
type RunResult = { raw: DevkitRunOutput; ok: boolean } | null;

function formatElapsed(elapsed: string): string {
  const s = parseFloat(elapsed);
  if (isNaN(s)) return elapsed;
  if (s >= 60) return `${(s / 60).toFixed(1)}m`;
  return `${s.toFixed(1)}s`;
}
type CheckResult = { raw: DevkitCheckOutput; ok: boolean } | null;
type GateResult = { raw: DevkitGateOutput; ok: boolean } | null;
type BaselineResult = { baseline: { timestamp: string; stats: { score: number; grade: string }; git?: { branch: string; commit: string } }; ok: boolean } | null;

// ── Task Runner ──────────────────────────────────────────────────────────────

function TaskRunnerCard({ availableTasks, defaultTasks }: { availableTasks: string[]; defaultTasks: string[] | null }) {
  const { antdToken: token } = useTheme();
  const notify = useNotification();

  const initial = defaultTasks ?? availableTasks.slice(0, 4);
  const [selected, setSelected] = React.useState<Set<string>>(new Set(initial));
  const [result, setResult] = React.useState<RunResult>(null);

  const run = useMutateData<{ tasks: string[] }, RunResult>(`${QA_BASE_PATH}${QA_ROUTES.RUN}`);

  const toggle = (task: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      next.has(task) ? next.delete(task) : next.add(task);
      return next;
    });

  const handleRun = () => {
    const tasks = [...selected];
    if (tasks.length === 0) { notify.error('Select at least one task'); return; }
    run.mutate({ tasks }, {
      onSuccess: (data) => setResult(data),
      onError: (err: unknown) => notify.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  const taskGroups = result?.raw.results
    ? (() => {
        const map = new Map<string, { passed: number; failed: number; cached: number; failures: string[] }>();
        for (const r of result.raw.results) {
          const e = map.get(r.Task) ?? { passed: 0, failed: 0, cached: 0, failures: [] };
          if (r.Cached) e.cached++;
          else if (r.OK) e.passed++;
          else { e.failed++; e.failures.push(r.Package); }
          map.set(r.Task, e);
        }
        return map;
      })()
    : null;

  return (
    <UICard
      title={<UISpace><UIIcon name="PlayCircleOutlined" /><span>Run Tasks</span></UISpace>}
      extra={
        <UIButton
          variant="primary"
          loading={run.isLoading}
          disabled={selected.size === 0}
          onClick={handleRun}
          icon={<UIIcon name="CaretRightOutlined" />}
        >
          Run {selected.size > 0 ? `(${selected.size})` : ''}
        </UIButton>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: token.marginMD }}>
        {availableTasks.map(task => {
          const isSelected = selected.has(task);
          return (
            <div
              key={task}
              onClick={() => toggle(task)}
              style={{
                cursor: 'pointer',
                padding: '2px 10px',
                borderRadius: 4,
                border: `1px solid ${isSelected ? token.colorPrimary : token.colorBorderSecondary}`,
                background: isSelected ? token.colorPrimaryBg : 'transparent',
                fontSize: token.fontSizeSM,
                fontWeight: isSelected ? 600 : 400,
                color: isSelected ? token.colorPrimary : token.colorTextSecondary,
                userSelect: 'none',
                transition: 'all 0.15s',
                lineHeight: '22px',
              }}
            >
              {task}
            </div>
          );
        })}
      </div>

      {result && taskGroups && (
        <>
          <UIDivider style={{ margin: `${token.marginSM}px 0` }} />
          <UIRow gutter={[8, 8]}>
            {[...taskGroups.entries()].map(([task, counts]) => {
              const total = counts.passed + counts.failed + counts.cached;
              const pct = total > 0 ? Math.round(((counts.passed + counts.cached) / total) * 100) : 100;
              const failed = counts.failed > 0;
              return (
                <UICol key={task} xs={24} sm={12} lg={8} xl={6}>
                  <div style={{
                    padding: `${token.paddingXS}px ${token.paddingSM}px`,
                    border: `1px solid ${failed ? token.colorErrorBorder : token.colorSuccessBorder}`,
                    borderRadius: token.borderRadius,
                    background: failed ? token.colorErrorBg : token.colorSuccessBg,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: token.fontSizeSM }}>{task}</span>
                      <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                        {counts.passed > 0 && `${counts.passed} pass`}
                        {counts.passed > 0 && counts.failed > 0 && ' · '}
                        {counts.failed > 0 && <span style={{ color: token.colorError }}>{counts.failed} fail</span>}
                        {(counts.passed > 0 || counts.failed > 0) && counts.cached > 0 && ' · '}
                        {counts.cached > 0 && `${counts.cached} cached`}
                      </span>
                    </div>
                    <UIProgress percent={pct} size="small" status={failed ? 'exception' : 'success'} showInfo={false} />
                    {counts.failures.length > 0 && (
                      <div style={{ marginTop: 4, fontSize: 11, color: token.colorError }}>
                        {counts.failures.slice(0, 2).map(p => <div key={p}>✗ {p}</div>)}
                        {counts.failures.length > 2 && <div style={{ color: token.colorTextSecondary }}>+{counts.failures.length - 2} more</div>}
                      </div>
                    )}
                  </div>
                </UICol>
              );
            })}
            <UICol xs={24}>
              <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                <UITag color={result.ok ? 'success' : 'error'} style={{ fontSize: 11 }}>
                  {result.ok ? '✓ passed' : '✗ failed'}
                </UITag>
                {' '}{formatElapsed(result.raw.elapsed)} · {result.raw.summary.total} pkgs
              </span>
            </UICol>
          </UIRow>
        </>
      )}
    </UICard>
  );
}

// ── Check Runner ─────────────────────────────────────────────────────────────

function CheckCard() {
  const { antdToken: token } = useTheme();
  const notify = useNotification();
  const [result, setResult] = React.useState<CheckResult>(null);
  const check = useMutateData<Record<string, never>, CheckResult>(`${QA_BASE_PATH}${QA_ROUTES.CHECK}`);

  const issuePackages = result?.raw.packages
    ? Object.entries(result.raw.packages)
        .filter(([, v]) => v.issues && v.issues.length > 0)
        .map(([pkg, v]) => ({
          key: pkg, pkg,
          errors: v.issues?.filter(i => i.severity === 'error').length ?? 0,
          warnings: v.issues?.filter(i => i.severity === 'warning').length ?? 0,
        }))
    : null;

  return (
    <UICard
      title={<UISpace><UIIcon name="SafetyCertificateOutlined" /><span>Structural Check</span></UISpace>}
      extra={
        <UIButton loading={check.isLoading} icon={<UIIcon name="AuditOutlined" />}
          onClick={() => check.mutate({}, {
            onSuccess: (d) => setResult(d),
            onError: (err: unknown) => notify.error(`Check failed: ${err instanceof Error ? err.message : String(err)}`),
          })}
        >
          Run Check
        </UIButton>
      }
    >
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.marginMD }}>
        <code>kb-devkit check</code> — README, tsconfig, engines, dependencies и прочие структурные требования.
      </div>
      {result && (
        <>
          <UIDivider style={{ margin: `${token.marginSM}px 0` }} />
          {!issuePackages?.length
            ? <UIAlert variant="success" showIcon message="All packages pass structural checks" />
            : <UITable dataSource={issuePackages} size="small"
                pagination={issuePackages.length > 8 ? { pageSize: 8 } : false}
                columns={[
                  { title: 'Package', dataIndex: 'pkg', key: 'pkg', ellipsis: true },
                  { title: 'Errors', dataIndex: 'errors', key: 'errors', width: 80,
                    render: (n: number) => n > 0 ? <UIBadge count={n} style={{ backgroundColor: token.colorError }} /> : '—' },
                  { title: 'Warnings', dataIndex: 'warnings', key: 'warnings', width: 90,
                    render: (n: number) => n > 0 ? <UIBadge count={n} style={{ backgroundColor: token.colorWarning }} /> : '—' },
                ]}
              />
          }
        </>
      )}
    </UICard>
  );
}

// ── Gate Check ───────────────────────────────────────────────────────────────

function GateCard() {
  const { antdToken: token } = useTheme();
  const notify = useNotification();
  const [result, setResult] = React.useState<GateResult>(null);
  const gate = useMutateData<Record<string, never>, GateResult>(`${QA_BASE_PATH}${QA_ROUTES.GATE}`);

  const violations = result?.raw.violations ?? [];

  return (
    <UICard
      title={<UISpace><UIIcon name="SecurityScanOutlined" /><span>Gate Check</span></UISpace>}
      extra={
        <UIButton loading={gate.isLoading} icon={<UIIcon name="ThunderboltOutlined" />}
          onClick={() => gate.mutate({}, {
            onSuccess: (d) => setResult(d),
            onError: (err: unknown) => notify.error(`Gate failed: ${err instanceof Error ? err.message : String(err)}`),
          })}
        >
          Run Gate
        </UIButton>
      }
    >
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.marginMD }}>
        <code>kb-devkit gate</code> — пре-коммит проверка staged файлов.
        {result ? ` Staged: ${result.raw.staged_files}` : ''}
      </div>
      {result && (
        <>
          <UIDivider style={{ margin: `${token.marginSM}px 0` }} />
          {result.ok
            ? <UIAlert variant="success" showIcon message="Gate passed — safe to commit" />
            : <>
                <UIAlert variant="error" showIcon message={`${violations.length} violation${violations.length !== 1 ? 's' : ''}`} style={{ marginBottom: token.marginSM }} />
                <UITable dataSource={violations.map((v, i) => ({ ...v, key: i }))} size="small" pagination={false}
                  columns={[
                    { title: 'Package', dataIndex: 'package', key: 'package', ellipsis: true },
                    { title: 'Check', dataIndex: 'check', key: 'check' },
                    { title: 'Severity', dataIndex: 'severity', key: 'severity', width: 90,
                      render: (s: string) => <UITag color={s === 'error' ? 'error' : 'warning'}>{s}</UITag> },
                    { title: 'Message', dataIndex: 'message', key: 'message', ellipsis: true },
                  ]}
                />
              </>
          }
        </>
      )}
    </UICard>
  );
}

// ── Baseline ─────────────────────────────────────────────────────────────────

function BaselineCard() {
  const { antdToken: token } = useTheme();
  const notify = useNotification();
  const [result, setResult] = React.useState<BaselineResult>(null);
  const update = useMutateData<Record<string, never>, BaselineResult>(`${QA_BASE_PATH}${QA_ROUTES.BASELINE_UPDATE}`);

  const baseline = result?.baseline;

  return (
    <UICard
      title={<UISpace><UIIcon name="AimOutlined" /><span>Baseline</span></UISpace>}
      extra={
        <UIButton loading={update.isLoading} icon={<UIIcon name="SaveOutlined" />}
          onClick={() => update.mutate({}, {
            onSuccess: (d) => { setResult(d); notify.success('Baseline updated'); },
            onError: (err: unknown) => notify.error(`Failed: ${err instanceof Error ? err.message : String(err)}`),
          })}
        >
          Update Baseline
        </UIButton>
      }
    >
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.marginMD }}>
        <code>kb-devkit check</code> + <code>kb-devkit stats</code> → сохраняет текущее состояние как новый baseline для diff.
      </div>
      {baseline && (
        <>
          <UIDivider style={{ margin: `${token.marginSM}px 0` }} />
          <UIAlert variant="success" showIcon message="Baseline saved"
            description={
              <UISpace>
                <span>Score: <strong>{baseline.stats?.score}/100</strong></span>
                <UITag color="processing">{baseline.stats?.grade}</UITag>
                <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                  {new Date(baseline.timestamp).toLocaleString()}
                  {baseline.git ? ` · ${baseline.git.branch} (${baseline.git.commit.slice(0, 7)})` : ''}
                </span>
              </UISpace>
            }
          />
        </>
      )}
    </UICard>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function RunTab() {
  const { antdToken: token } = useTheme();
  const { data: tasksData, isLoading } = useData<TasksResponse>(`${QA_BASE_PATH}${QA_ROUTES.TASKS}`);

  if (isLoading) {
    return <UISkeleton active lines={5} />;
  }

  const availableTasks = tasksData?.tasks ?? [];

  return (
    <UISpace direction="vertical" style={{ width: '100%' }} size="large">
      {availableTasks.length === 0 ? (
        <UIAlert variant="warning" showIcon message="devkit.yaml not found"
          description="Add a devkit.yaml to the root of your repository to configure available tasks."
        />
      ) : (
        <TaskRunnerCard availableTasks={availableTasks} defaultTasks={tasksData?.defaultTasks ?? null} />
      )}
      <UIRow gutter={[16, 16]}>
        <UICol xs={24} lg={12}><CheckCard /></UICol>
        <UICol xs={24} lg={12}><GateCard /></UICol>
      </UIRow>
      <BaselineCard />
    </UISpace>
  );
}
