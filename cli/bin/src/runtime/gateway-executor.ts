/**
 * Gateway Executor — thin client execution path.
 *
 * When Gateway is available (Host Agent IPC or HTTP credentials),
 * plugin commands execute remotely instead of locally.
 *
 * CLI → resolveTransport() → IGatewayClient.execute() → stream events → render
 *
 * Ctrl+C → client.cancel(executionId) → Gateway aborts execution (CC2).
 */

import type { IGatewayClient, GatewayExecuteRequest } from '@kb-labs/sdk/gateway';
import { HttpSseGatewayTransport, resolveTransport, TerminalEventRenderer } from '@kb-labs/cli-runtime/gateway';
import type { RegisteredCommand } from '@kb-labs/cli-commands';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';
import type { CliResultWriter } from './result-serializer.js';
import { randomUUID } from 'node:crypto';

export interface GatewayExecutionOptions {
  commandId: string;
  projectId?: string;
  argv: string[];
  flags: Record<string, unknown>;
  manifestCmd: RegisteredCommand | undefined;
  resultWriter: CliResultWriter;
}

export function pluginCommandUnavailable(commandPath: string): ErrorEnvelopeError {
  return new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
    message: `Plugin command "${commandPath}" has no executable handler in its manifest.`,
    hint: 'Run `kb marketplace plugins doctor --scope platform` to inspect the installed manifest, then update or rebuild the plugin with its command handler.',
    details: { command: commandPath },
  }));
}

/**
 * Try to resolve a Gateway transport.
 * Returns null if no Gateway is available (fall back to local execution).
 */
export async function tryResolveGateway(gatewayUrl: string): Promise<IGatewayClient> {
  return resolveTransport(gatewayUrl);
}

/** Verified installed local hosts use their authenticated Gateway, never the Workspace Agent socket. */
export function resolveProjectRuntimeGateway(gatewayUrl: string): IGatewayClient {
  return new HttpSseGatewayTransport({ gatewayUrl, credentialKind: 'either' });
}

/**
 * Execute a plugin command via Gateway (thin client mode).
 *
 * Returns exit code from the execution:done event.
 * Handles Ctrl+C by sending cancel request to Gateway.
 */
export async function executeViaGateway(
  client: IGatewayClient,
  options: GatewayExecutionOptions,
): Promise<number> {
  const { commandId, argv, flags, manifestCmd, resultWriter } = options;

  if (!manifestCmd) {
    throw pluginCommandUnavailable(commandId);
  }

  // Build Gateway execute request from manifest command
  const v3Manifest = manifestCmd.manifest.v3Manifest;
  const pluginId = v3Manifest?.id || manifestCmd.manifest.id;
  const commandPath = manifestCmd.manifest.segments.join(' ');
  const cliCommand = v3Manifest?.cli?.commands?.find((c) => c.path === commandPath);
  const handlerRef = cliCommand?.handler?.split('#')[0] ?? '';

  const projectId = options.projectId;
  const request: GatewayExecuteRequest = {
    pluginId,
    handlerRef,
    exportName: cliCommand?.handler?.split('#')[1] ?? 'default',
    input: { argv, flags },
  };
  const projectRequest = {
    requestId: randomUUID(),
    pluginId,
    commandPath,
    input: { argv, flags },
  };

  const renderer = new TerminalEventRenderer();
  let exitCode = 1;
  let executionId: string | undefined;
  let cancelled = false;

  // Ctrl+C handler — cancel remote execution via Gateway
  const onSigint = () => {
    if (!cancelled && (projectId || executionId)) {
      cancelled = true;
      const cancellationId = projectId && !executionId ? projectRequest.requestId : executionId;
      if (cancellationId) { void client.cancel(cancellationId, 'user'); }
    }
  };
  process.on('SIGINT', onSigint);

  try {
    if (projectId && !client.executeProject) {
      throw new Error('The selected Gateway transport cannot execute through a project runtime.');
    }
    const events = projectId
      ? client.executeProject!(projectId, projectRequest)
      : client.execute(request);
    for await (const event of events) {
      // Track executionId from first event
      if (!executionId && 'executionId' in event) {
        executionId = event.executionId;
      }

      if (process.env.KB_OUTPUT_MODE === 'json' && event.type === 'execution:output') {
        // Gateway stdout/stderr are command diagnostics at the CLI boundary.
        // Keep the single machine result on stdout, but do not discard these events.
        process.stderr.write(event.data);
      } else {
        renderer.render(event);
      }

      if (event.type === 'execution:done') {
        exitCode = event.exitCode ?? 0;
        if (process.env.KB_OUTPUT_MODE === 'json' && exitCode === 0) {
          resultWriter({
            ok: true,
            data: event.metadata?.result ?? null,
            ...(event.metadata?.executionOwner === 'project-runtime' ? {
              meta: { execution: { owner: event.metadata.executionOwner, projectId: event.metadata.projectId, mode: event.metadata.executionMode } },
            } : {}),
          });
        }
      } else if (event.type === 'execution:error' && process.env.KB_OUTPUT_MODE === 'json') {
        resultWriter({ ok: false, error: event.error });
      }
    }
    if (cancelled) { exitCode = 130; }
  } catch (error) {
    if (!cancelled) { throw error; }
    exitCode = 130;
  } finally {
    process.removeListener('SIGINT', onSigint);
    renderer.finish();
    await client.close();
  }

  return exitCode;
}
