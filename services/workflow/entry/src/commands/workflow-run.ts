/**
 * workflow:run command - Run workflow by workflow ID
 */

import { createErrorEnvelope, defineCommand, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import type { WorkflowRunRequest } from '@kb-labs/workflow-contracts';
import { WorkflowDaemonClient } from '../http-client.js';

export interface WorkflowRunFlagsInput {
  json?: boolean;
  'workflow-id'?: string;
  input?: string;
  isolation?: string;
  'trigger-type'?: string;
  'trigger-user'?: string;
  'target-environment-id'?: string;
  'target-workspace-id'?: string;
  'target-namespace'?: string;
  'target-workdir'?: string;
}

function parseJsonInput(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw inputError('The --input value is not valid JSON.', 'Pass valid JSON with `--input`, then retry `kb workflow run`.');
  }
}

function inputError(message: string, hint: string): Error & { envelope: ReturnType<typeof createErrorEnvelope> } {
  const error = new Error(message) as Error & { envelope: ReturnType<typeof createErrorEnvelope> };
  error.envelope = createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { message, hint });
  return error;
}

function parseIsolation(value: string | undefined): WorkflowRunRequest['isolation'] {
  if (!value) {
    return undefined;
  }
  if (value === 'strict' || value === 'balanced' || value === 'relaxed') {
    return value;
  }
  throw inputError(`Invalid isolation value: ${value}. Expected strict|balanced|relaxed.`, 'Use `--isolation=strict`, `--isolation=balanced`, or `--isolation=relaxed`.');
}

function parseTriggerType(value: string | undefined): WorkflowRunRequest['trigger'] {
  if (!value) {
    return undefined;
  }
  if (value === 'manual') {
    return { type: value };
  }
  throw inputError(`Invalid trigger type: ${value}. Expected manual.`, 'Use `--trigger-type=manual`; schedules are created with `kb workflow cron`.');
}

export default defineCommand<unknown, CLIInput<WorkflowRunFlagsInput>, unknown>({
  id: 'workflow:run',
  description: 'Run workflow by ID with optional target/isolation overrides and a JSON payload via --input.',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<WorkflowRunFlagsInput>): Promise<CommandResult> {
      const outputJson = input.flags.json ?? false;
      const workflowId = input.flags['workflow-id'];

      if (!workflowId) {
        return handleError(inputError('Missing required flag: --workflow-id.', 'Run `kb workflow run --help` to see the required flags.'));
      }

      try {
        const request: WorkflowRunRequest = {};

        const inputPayload = parseJsonInput(input.flags.input);
        if (inputPayload !== undefined) {
          request.input = inputPayload;
        }

        const isolation = parseIsolation(input.flags.isolation);
        if (isolation) {
          request.isolation = isolation;
        }

        const trigger = parseTriggerType(input.flags['trigger-type']);
        if (trigger) {
          request.trigger = {
            ...trigger,
            user: input.flags['trigger-user'],
          };
        } else if (input.flags['trigger-user']) {
          request.trigger = {
            type: 'manual',
            user: input.flags['trigger-user'],
          };
        }

        const target = {
          environmentId: input.flags['target-environment-id'],
          workspaceId: input.flags['target-workspace-id'],
          namespace: input.flags['target-namespace'],
          workdir: input.flags['target-workdir'],
        };
        if (target.environmentId || target.workspaceId || target.namespace || target.workdir) {
          request.target = target;
        }

        const client = new WorkflowDaemonClient();
        const result = await client.runWorkflow(workflowId, request);

        if (outputJson) {
          return result;
        } else {
          ctx.ui?.success?.('Workflow run submitted', {
            title: 'Workflow Engine',
            sections: [{
              header: 'Details',
              items: [
                `Workflow ID: ${workflowId}`,
                `Run ID: ${result.runId}`,
                `Status: ${result.status}`,
                ...(request.isolation ? [`Isolation: ${request.isolation}`] : []),
                ...(request.target?.namespace ? [`Target Namespace: ${request.target.namespace}`] : []),
                ...(request.target?.environmentId ? [`Target Environment: ${request.target.environmentId}`] : []),
                ...(request.target?.workspaceId ? [`Target Workspace: ${request.target.workspaceId}`] : []),
              ],
            }],
          });
        }

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
