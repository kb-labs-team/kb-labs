/**
 * workflow:runs-watch <runId> command — like `gh run watch`
 *
 * Streams run events in real-time via SSE endpoint.
 */

import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';

export interface RunsWatchFlags {
  'run-id'?: string;
  json?: boolean;
  logs?: boolean;
}

const STATUS_ICON: Record<string, string> = {
  success: '✓',
  failed: '✗',
  running: '⠿',
  queued: '○',
  cancelled: '⊘',
  waiting_approval: '⏳',
  waiting_child: '⏳',
  interrupted: '‖',
};

export default defineCommand<unknown, CLIInput<RunsWatchFlags>, unknown>({
  id: 'workflow:runs-watch',
  description: 'Stream workflow run events in real-time',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsWatchFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const outputJson = flags?.json ?? false;
      const logsOnly = flags?.logs ?? false;
      let runId = flags?.['run-id'] ?? argv[0];
      const events: Array<{ type: string; runId?: string; jobId?: string; stepId?: string; payload?: Record<string, unknown> }> = [];

      try {
        const client = new WorkflowDaemonClient();

        // No run ID supplied — watch the latest run (like `gh run watch`)
        if (!runId) {
          const latest = await client.listRuns({ limit: 1 });
          if (!latest.length) {
            if (!outputJson) { ctx.ui?.info?.('No runs found'); }
            return { events };
          }
          runId = latest[0]!.id!;
          if (!outputJson) { ctx.ui?.info?.(`Watching latest run: ${runId}`); }
        }

        if (!outputJson) { ctx.ui?.info?.(`Watching run ${runId} (Ctrl+C to stop)...`); }

        // Use fetch with streaming to consume SSE
        const response = await client.fetchRunEvents(runId, {
          headers: { Accept: 'text/event-stream' },
        });

        if (!response.ok || !response.body) {
          throw new Error(`Failed to connect to events stream: ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const stepIds = new Map<string, string>();

        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data:')) { continue; }
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') { continue; }

            try {
              const event = JSON.parse(raw) as { type: string; runId?: string; jobId?: string; stepId?: string; payload?: Record<string, unknown> };

              // Stream log lines from handler (ctx.logger.* / ctx.ui.* / console.log)
              // Rendered as compact single lines, not boxes.
              // See: services/workflow/docs/adr/0019-log-stream-separation.md
              if (event.type === 'log.appended') {
                if (outputJson) { events.push(event); }
                const p = event.payload as { level?: string; message?: string; stepName?: string } | undefined;
                const label = p?.stepName ?? (event.stepId ? event.stepId.slice(0, 8) : '');
                const prefix = label ? `[${label}] ` : '';
                if (!outputJson) {
                  ctx.ui?.log?.({
                    level: (p?.level ?? 'info') as 'info' | 'warn' | 'error' | 'debug',
                    message: `${prefix}${p?.message ?? ''}`,
                  });
                }
                continue;
              }

              // --logs: suppress non-log events
              if (logsOnly) { continue; }
              if (outputJson) { events.push(event); }

              const icon = STATUS_ICON[(event.payload?.['status'] as string) ?? ''] ?? '·';
              if (event.type === 'run.snapshot') {
                const jobs = event.payload?.['jobs'];
                if (Array.isArray(jobs)) {
                  for (const job of jobs) {
                    if (typeof job !== 'object' || job === null || !('steps' in job) || !Array.isArray(job.steps)) { continue; }
                    for (const stepRecord of job.steps) {
                      if (typeof stepRecord !== 'object' || stepRecord === null || !('id' in stepRecord) || typeof stepRecord.id !== 'string' || !('spec' in stepRecord) || typeof stepRecord.spec !== 'object' || stepRecord.spec === null || !('id' in stepRecord.spec) || typeof stepRecord.spec.id !== 'string') { continue; }
                      stepIds.set(stepRecord.id, stepRecord.spec.id);
                      const stepStatus = stepRecord.status === 'running' ? 'started' :
                        stepRecord.status === 'success' ? 'succeeded' :
                        stepRecord.status === 'failed' ? 'failed' : undefined;
                      if (stepStatus) {
                        const jobId = typeof job.id === 'string' ? job.id : undefined;
                        const jobLabel = jobId ? ` job:${jobId}` : '';
                        const stepIcon = STATUS_ICON[stepRecord.status] ?? '·';
                        if (!outputJson) { ctx.ui?.write?.(`${stepIcon} step.${stepStatus}${jobLabel} step:${stepRecord.spec.id}`); }
                      }
                    }
                  }
                }
                continue;
              }
              const stepId = event.stepId ? stepIds.get(event.stepId) ?? event.stepId : undefined;
              const step = stepId ? ` step:${stepId}` : '';
              const job = event.jobId ? ` job:${event.jobId.slice(0, 8)}` : '';
              const summary = event.payload?.['summary'] ?? event.payload?.['error'] ?? '';

              if (!outputJson) { ctx.ui?.write?.(`${icon} ${event.type}${job}${step}${summary ? `  —  ${summary}` : ''}`); }

              // Terminal events
              if (event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled') {
                const finalStatus = event.payload?.['status'] as string ?? event.type.split('.')[1];
                if (!outputJson) { ctx.ui?.write?.(`Run ${finalStatus.toUpperCase()}. Use 'kb workflow runs view ${runId}' for details.`); }
                if (finalStatus !== 'success') {
                  return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `Workflow run ${runId} ended with status ${finalStatus}.`, hint: `Inspect the run with: kb workflow runs view ${runId}`, diagnostics: [{ code: 'WORKFLOW_RUN_FAILED', severity: 'error', path: runId, message: `Workflow run ended with status ${finalStatus}.` }] } };
                }
                return { events };
              }
            } catch {
              // Ignore malformed events
            }
          }
        }

        return { events };
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
