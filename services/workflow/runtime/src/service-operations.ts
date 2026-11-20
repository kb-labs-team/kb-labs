import type { RegisteredServiceCommandOperation, ServiceCommandRequestCapability } from '@kb-labs/plugin-contracts';
import type { ErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { isErrorEnvelope } from '@kb-labs/core-platform';
import { workflowServiceCommands } from '@kb-labs/workflow-contracts/service-commands';

export class WorkflowServiceOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
    readonly envelope?: ErrorEnvelope,
  ) {
    super(message);
    this.name = 'WorkflowServiceOperationError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** One host-neutral cron toggle operation shared by CLI and project MCP. */
export async function setWorkflowCronEnabled(
  input: Record<string, unknown>,
  request: ServiceCommandRequestCapability,
): Promise<{ id: string; enabled: boolean }> {
  const id = input.id;
  const enabled = input.enabled;
  if (typeof id !== 'string' || id.length === 0 || typeof enabled !== 'boolean') {
    throw new WorkflowServiceOperationError('KB_RUNTIME_INPUT_INVALID', 'A cron ID and enabled state are required.');
  }

  const declaration = enabled
    ? workflowServiceCommands.commands.cronsEnable
    : workflowServiceCommands.commands.cronsDisable;
  const route = declaration.route.path.replace('{id}', encodeURIComponent(id));
  const response = await request({
    method: declaration.route.method,
    // Service operations speak service-relative paths. The host adapter owns
    // mounting this under the manifest's public project API prefix.
    path: route,
  });
  const envelope = record(response.payload);
  const failure = record(envelope?.error);
  if (!response.ok || envelope?.ok === false) {
    const code = typeof failure?.code === 'string' ? failure.code : 'KB_RUNTIME_COMMAND_FAILED';
    const message = typeof failure?.message === 'string'
      ? failure.message
      : `Failed to ${enabled ? 'enable' : 'disable'} cron ${id}.`;
    const hint = typeof failure?.hint === 'string' ? failure.hint : undefined;
    const details = record(failure?.details);
    const correlationId = typeof failure?.correlationId === 'string' ? failure.correlationId : undefined;
    const errorEnvelope = isErrorEnvelope(failure) ? failure : undefined;
    throw new WorkflowServiceOperationError(code, message, hint, details, correlationId, errorEnvelope);
  }

  const data = envelope?.ok === true ? record(envelope.data) : envelope;
  if (typeof data?.enabled !== 'boolean') {
    throw new WorkflowServiceOperationError('KB_RUNTIME_COMMAND_FAILED', 'The workflow service returned an invalid cron update result.');
  }
  return { id, enabled: data.enabled };
}

export const workflowServiceOperations: readonly RegisteredServiceCommandOperation[] = [
  {
    serviceId: 'workflow',
    operationId: 'workflow.cron.set-enabled',
    execute: setWorkflowCronEnabled,
  },
];
