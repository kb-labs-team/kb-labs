/**
 * workflow:runs-view <runId> command — like `gh run view`
 *
 * Designed for incident investigation: shows the full run tree with step
 * details, resolvedInputs, gate decisions, and error context.
 * Use --log-failed to see only the logs from failed steps.
 */

import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import type { WorkflowRunDetail } from '../http-client.js';
import { WorkflowDaemonClient } from '../http-client.js';
import { workflowCommandError } from './errors.js';
import { gatewayApiFetch } from '@kb-labs/sdk/gateway';

export interface RunsViewFlags {
  'run-id'?: string;
  json?: string | boolean;
  log?: boolean;
  'log-failed'?: boolean;
  step?: string;
  output?: boolean;
}

const STEP_ICON: Record<string, string> = {
  success: '✓',
  failed: '✗',
  running: '◆',
  queued: '○',
  cancelled: '⊘',
  waiting_approval: '…',
  // Jobs can carry this status too now (parked while a step invokes a
  // nested workflow), not just steps — same lookup table serves both.
  waiting_child: '…',
  interrupted: '‖',
  skipped: '⊙',
};

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) { return ''; }
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

interface RunSection {
  header: string;
  items: string[];
}

type StepLogEntry = { message: string; level: string; stream?: string };

interface RenderRunOpts {
  maxStdoutLines?: number;
}

function renderRun(run: WorkflowRunDetail, stepLogs?: Record<string, StepLogEntry[]>, opts?: RenderRunOpts): RunSection[] {
  const sections: RunSection[] = [];

  // Summary
  const dur = formatDuration(run.durationMs);
  const trigger = run.trigger
    ? `${run.trigger.type} by ${run.trigger.actor ?? 'unknown'}`
    : 'manual';
  const summary: string[] = [
    `Status:   ${run.status.toUpperCase()}`,
    `Trigger:  ${trigger}`,
  ];
  if (dur) { summary.push(`Duration: ${dur}`); }
  if (run.inputs && Object.keys(run.inputs).length > 0) {
    summary.push(`Inputs:   ${JSON.stringify(run.inputs)}`);
  }
  const parentRunId = run.trigger?.parentRunId ?? run.metadata?.['parentRunId'];
  if (typeof parentRunId === 'string') {
    summary.push(`Parent:   ${parentRunId}`);
  }
  const ancestors = run.metadata?.['workflowAncestors'];
  if (Array.isArray(ancestors) && ancestors.length > 0) {
    summary.push(`Lineage:  ${ancestors.join(' → ')}`);
  }
  if (run.result?.outputs && Object.keys(run.result.outputs).length > 0) {
    summary.push(`Outputs:  ${JSON.stringify(run.result.outputs)}`);
  }
  if (run.result?.summary) {
    summary.push(`Result:   ${run.result.summary}`);
  }
  sections.push({ header: run.name, items: summary });

  // Jobs
  for (const job of run.jobs ?? []) {
    const jIcon = STEP_ICON[job.status] ?? '?';
    const jDur = formatDuration(job.durationMs);
    const jAttempt = (job.attempt ?? 1) > 1 ? `  attempt ${job.attempt}` : '';
    const jobItems: string[] = [];

    if (job.error) {
      const errMsg = typeof job.error === 'string' ? job.error : job.error.message;
      jobItems.push(`Error: ${errMsg}`);
    }

    for (const step of job.steps ?? []) {
      const sIcon = STEP_ICON[step.status] ?? '?';
      const sDur = formatDuration(step.durationMs);
      const stepName = step.name ?? step.id;
      jobItems.push(`${sIcon}  ${stepName}  —  ${step.status}${sDur ? `  ${sDur}` : ''}`);

      const uses = (step.spec as Record<string, unknown> | undefined)?.['uses'] as string | undefined;
      if (uses?.startsWith('builtin:gate') && step.outputs) {
        const out = step.outputs as Record<string, unknown>;
        if (out['decision'] !== undefined || out['decisionValue'] !== undefined) {
          const expr = (step.resolvedInputs as Record<string, unknown> | undefined)?.['decision'];
          jobItems.push(`   Decision: ${expr ?? '?'} → ${out['decisionValue'] ?? out['decision']}`);
          if (out['action']) { jobItems.push(`   Action: ${out['action']}`); }
          if (out['restartFrom']) { jobItems.push(`   Restart from: ${out['restartFrom']}`); }
          if (out['iteration'] !== undefined) { jobItems.push(`   Iteration: ${out['iteration']}`); }
        }
      }

      if (step.error) {
        const errMsg = typeof step.error === 'string' ? step.error : step.error.message;
        const errCode = typeof step.error !== 'string' ? step.error.code : undefined;
        jobItems.push(`   Error: ${errMsg}${errCode ? ` [${errCode}]` : ''}`);
        if (step.resolvedInputs && Object.keys(step.resolvedInputs).length > 0) {
          jobItems.push(`   Inputs: ${JSON.stringify(step.resolvedInputs)}`);
        }
        if (typeof step.error !== 'string' && step.error.details) {
          jobItems.push(`   Details: ${JSON.stringify(step.error.details)}`);
        }
      }

      if (step.outputs && Object.keys(step.outputs).length > 0) {
        for (const [k, v] of Object.entries(step.outputs)) {
          let raw: string;
          if (typeof v === 'string') {
            raw = v;
          } else {
            try { raw = JSON.stringify(v); } catch { raw = '[circular]'; }
          }
          const display = raw.length > 120 ? raw.slice(0, 117) + '…' : raw;
          jobItems.push(`   ${k}: ${display}`);
        }
      }

      const logs = stepLogs?.[step.id];
      if (logs?.length) {
        const maxLines = opts?.maxStdoutLines ?? 20;
        const shown = maxLines === Infinity ? logs : logs.slice(-maxLines);
        for (const l of shown) {
          const tag = l.stream === 'stderr' ? 'ERR' : 'OUT';
          jobItems.push(`   [${tag}] ${l.message}`);
        }
        if (maxLines !== Infinity && logs.length > maxLines) {
          jobItems.push(`   … ${logs.length - maxLines} earlier lines (use --log --step=${step.id})`);
        }
      }
    }

    sections.push({
      header: `${jIcon}  ${job.jobName ?? job.id}${jDur ? `  ${jDur}` : ''}${jAttempt}`,
      items: jobItems,
    });
  }

  return sections;
}

function pickFields(run: WorkflowRunDetail, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    result[field] = (run as unknown as Record<string, unknown>)[field];
  }
  return result;
}

export default defineCommand<unknown, CLIInput<RunsViewFlags>, unknown>({
  id: 'workflow:runs-view',
  description: 'View workflow run details for investigation',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsViewFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const rawJson = flags?.json;
      const jsonFields: string | undefined =
        rawJson === true || rawJson === ''
          ? 'all'
          : typeof rawJson === 'string'
            ? rawJson
            : undefined;
      let runId = flags?.['run-id'] ?? argv[0];

      const showLogFailed = flags?.['log-failed'] ?? false;
      const showLog = flags?.log ?? false;
      const showOutput = flags?.output ?? false;
      const stepFilter = flags?.step;

      try {
        const client = new WorkflowDaemonClient();

        // No run ID supplied — use the latest run (like `gh run view`)
        if (!runId) {
          const latest = await client.listRuns({ limit: 1 });
          if (!latest.length) {
            ctx.ui?.info?.('No runs found');
            return undefined;
          }
          runId = latest[0]!.id!;
          ctx.ui?.info?.(`Showing latest run: ${runId}`);
        }

        const run = await client.getRun(runId);

        // --json=fields output (--json=all for full, --json=status,jobs for selective)
        if (jsonFields) {
          if (jsonFields === 'all') {
            return run;
          } else {
            const fields = jsonFields.split(',').map(f => f.trim());
            return pickFields(run, fields);
          }
        }

        // --log or --log-failed: show run logs
        if (showLog || showLogFailed) {
          const failedStepId = showLogFailed
            ? run.jobs?.flatMap(j => j.steps ?? []).find(s => s.status === 'failed')?.id
            : undefined;
          const effectiveStepId = stepFilter ?? failedStepId;

          const TERMINAL = new Set(['success', 'failed', 'cancelled']);
          const isRunning = !TERMINAL.has(run.status ?? '');

          if (isRunning) {
            // Run still in progress — stream live via SSE
            ctx.ui?.info?.(`Streaming logs for run ${runId} (Ctrl+C to stop)...`);
            const eventsUrl = client.getRunEventsUrl(runId);
            const response = await gatewayApiFetch(eventsUrl, { headers: { Accept: 'text/event-stream' } });
            if (!response.ok || !response.body) {
              throw new Error(`Failed to connect to events stream: ${response.statusText}`);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) { break; }
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data:')) { continue; }
                const raw = line.slice(5).trim();
                if (!raw || raw === '[DONE]') { continue; }
                try {
                  const event = JSON.parse(raw) as { type: string; stepId?: string; payload?: Record<string, unknown> };
                  if (event.type === 'log.appended') {
                    if (effectiveStepId && event.stepId !== effectiveStepId) { continue; }
                    const p = event.payload ?? {};
                    const isErr = p['level'] === 'error' || p['stream'] === 'stderr';
                    if (showLogFailed && !isErr) { continue; }
                    const lvl = isErr ? 'ERR' : 'LOG';
                    const stepCtx = event.stepId ? ` [${event.stepId}]` : '';
                    ctx.ui?.info?.(`  ${lvl}${stepCtx} ${p['message'] ?? ''}`);
                  } else if (TERMINAL.has(event.type?.split('.')[1] ?? '')) {
                    break;
                  }
                } catch { /* skip malformed */ }
              }
            }
            return undefined;
          }

          // Run already completed — fetch historical logs
          const logs = await client.getRunLogs(runId, { stepId: effectiveStepId });

          const filteredLogs = showLogFailed
            ? logs.filter(l => l['level'] === 'error' || l['level'] === 'warn' || String(l['message']).includes('failed') || String(l['message']).includes('[gate]') || String(l['message']).includes('[approval]'))
            : logs;

          if (filteredLogs.length === 0) {
            ctx.ui?.info?.('No logs found');
            return undefined;
          }

          const logLines = filteredLogs.map(l => {
            const ts = l['timestamp'] ? String(l['timestamp']).slice(11, 23) : '';
            const level = String(l['level'] ?? 'info').toUpperCase().slice(0, 4);
            const step = l['stepName'] ?? l['stepId'] ? `[${l['stepName'] ?? l['stepId']}] ` : '';
            return `${ts} ${level} ${step}${l['message']}`;
          });

          const sections: Array<{ header: string; items: string[] }> = [
            { header: showLogFailed ? 'Failed step logs' : 'Run logs', items: logLines },
          ];
          ctx.ui?.success?.(`Run ${runId}`, { title: run.name, sections });
          return undefined;
        }

        // Default: show run tree (optionally with per-step stdout)
        let stepLogs: Record<string, StepLogEntry[]> | undefined;
        if (showOutput) {
          try {
            const allLogs = await client.getRunLogs(runId, stepFilter ? { stepId: stepFilter } : {});
            stepLogs = {};
            for (const l of allLogs) {
              const sid = l.stepId ?? (l['context'] as Record<string, unknown> | undefined)?.['stepId'] as string | undefined;
              if (!sid) { continue; }
              (stepLogs[sid] ??= []).push({
                message: String(l.message ?? ''),
                level: String(l.level ?? 'info'),
                stream: l.stream ?? (l['context'] as Record<string, unknown> | undefined)?.['logSource'] as string | undefined,
              });
            }
          } catch {
            // getRunLogs failure is non-fatal — render tree without step logs
          }
        }

        // When a single step is targeted via --step, lift the inline stdout cap
        const maxStdoutLines = stepFilter ? Infinity : 20;
        const sections = renderRun(run, stepLogs, { maxStdoutLines });
        const failed = run.status === 'failed';
        const status = failed ? 'error' : 'success';

        ctx.ui?.sideBox?.({
          title: runId,
          status,
          sections,
        });

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
