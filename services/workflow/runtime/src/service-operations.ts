import type { RegisteredServiceCommandOperation, ServiceCommandRequestCapability } from '@kb-labs/plugin-contracts';
import type { ErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { createErrorEnvelope, isErrorEnvelope } from '@kb-labs/core-platform';
import { randomUUID } from 'node:crypto';
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

function operationFailure(
  message: string,
  hint: string,
  details: Record<string, unknown>,
): WorkflowServiceOperationError {
  const envelope = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
    message, hint, details, correlationId: randomUUID(),
  });
  return new WorkflowServiceOperationError(
    envelope.code, envelope.message, envelope.hint, envelope.details, envelope.correlationId, envelope,
  );
}

function gatewayProtocolFailure(
  statusCode: number,
  gatewayUrl?: string,
): WorkflowServiceOperationError {
  const envelope = createErrorEnvelope('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE', {
    details: {
      httpStatus: String(statusCode),
      requestStage: 'Gateway request',
      gatewayUrl: gatewayUrl ?? '<url>',
    },
    correlationId: randomUUID(),
  });
  return new WorkflowServiceOperationError(
    envelope.code, envelope.message, envelope.hint, envelope.details, envelope.correlationId, envelope,
  );
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
    const envelope = createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
      message: 'A cron ID and enabled state are required.',
      hint: 'Provide a non-empty cron ID and retry the command.',
      details: { field: 'id' },
      correlationId: randomUUID(),
    });
    throw new WorkflowServiceOperationError(
      envelope.code, envelope.message, envelope.hint, envelope.details, envelope.correlationId, envelope,
    );
  }

  const declaration = enabled
    ? workflowServiceCommands.commands.cronsEnable
    : workflowServiceCommands.commands.cronsDisable;
  const route = declaration.route.path.replace('{id}', encodeURIComponent(id));
  let response: Awaited<ReturnType<ServiceCommandRequestCapability>>;
  try {
    response = await request({
      method: declaration.route.method,
      // Service operations speak service-relative paths. The host adapter owns
      // mounting this under the manifest's public project API prefix.
      path: route,
    });
  } catch (error) {
    const thrownEnvelope = record(error)?.envelope;
    if (isErrorEnvelope(thrownEnvelope)) {
      const errorEnvelope = { ...thrownEnvelope, correlationId: thrownEnvelope.correlationId ?? randomUUID() };
      throw new WorkflowServiceOperationError(
        errorEnvelope.code, errorEnvelope.message, errorEnvelope.hint, errorEnvelope.details,
        errorEnvelope.correlationId, errorEnvelope,
      );
    }
    throw operationFailure('The workflow service could not complete the cron update.',
      'Check workflow service health, then retry the command.', { command: 'workflow cron toggle' });
  }
  const envelope = record(response.payload);
  const failure = record(envelope?.error);
  if (!response.ok || envelope?.ok === false) {
    const errorEnvelope = isErrorEnvelope(failure)
      ? { ...failure, correlationId: failure.correlationId ?? randomUUID() }
      : undefined;
    if (errorEnvelope) {
      throw new WorkflowServiceOperationError(
        errorEnvelope.code, errorEnvelope.message, errorEnvelope.hint, errorEnvelope.details,
        errorEnvelope.correlationId, errorEnvelope,
      );
    }
    throw gatewayProtocolFailure(response.statusCode, response.gatewayUrl);
  }

  const data = envelope?.ok === true ? record(envelope.data) : envelope;
  if (typeof data?.enabled !== 'boolean') {
    throw gatewayProtocolFailure(response.statusCode, response.gatewayUrl);
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
