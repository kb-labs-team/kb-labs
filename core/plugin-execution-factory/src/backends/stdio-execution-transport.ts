import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import type { ExecutionTransportOptions, IExecutionTransport, IPlatformAdapters, TransportExecutionResult } from '@kb-labs/core-platform';
import { SerializedErrorEnvelopeError } from '@kb-labs/core-platform';
import { AbortError } from '@kb-labs/plugin-contracts';
import type { ErrorEnvelope, SerializedError } from '@kb-labs/core-platform';
import { createStdioChannel, StdioPlatformServer } from '@kb-labs/core-ipc';
import type { ExecutionRequest } from '@kb-labs/core-platform';
import type { EnvironmentExecutionStream } from '@kb-labs/core-platform/adapters';
import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';

/** Drives a runtime process using the shared stdio protocol and host-side platform RPC. */
export class StdioExecutionTransport implements IExecutionTransport {
  private readonly channel;
  private readonly platformServer: StdioPlatformServer;
  private readonly writable: Writable;

  constructor(stream: EnvironmentExecutionStream, platform: IPlatformAdapters) {
    this.writable = stream.writable;
    this.channel = createStdioChannel(stream.readable, stream.writable);
    this.platformServer = new StdioPlatformServer(this.channel, platform);
    this.channel.on('log', (frame) => {
      platform.logger.info(frame.message, { level: frame.level, stream: frame.stream, ...frame.meta });
    });
    let diagnosticBuffer = '';
    stream.diagnostics.on('data', (chunk: Buffer) => {
      diagnosticBuffer += chunk.toString('utf8');
      const lines = diagnosticBuffer.split(/\r?\n/);
      diagnosticBuffer = lines.pop() ?? '';
      for (const line of lines) { platform.logger.error(line, undefined, { stream: 'stderr', source: 'container' }); }
    });
    stream.diagnostics.on('end', () => {
      if (diagnosticBuffer.length > 0) { platform.logger.error(diagnosticBuffer, undefined, { stream: 'stderr', source: 'container' }); }
    });
  }

  execute(request: ExecutionRequest, options?: ExecutionTransportOptions): Promise<TransportExecutionResult> {
    const requestId = request.executionId;
    return new Promise((resolveResult, reject) => {
      let settled = false;
      let finishPromise: Promise<void> | undefined;
      const unsubscribers: Array<() => void> = [];
      const abortHandler = () => {
        if (settled) { return; }
        void this.channel.send({ type: 'execution:cancel', requestId }).catch(() => {});
        fail(new AbortError());
      };
      const finish = () => {
        if (finishPromise) { return finishPromise; }
        settled = true;
        for (const unsubscribe of unsubscribers) { unsubscribe(); }
        options?.signal?.removeEventListener('abort', abortHandler);
        finishPromise = this.platformServer.close().catch(() => {}).then(() => this.channel.close());
        return finishPromise;
      };
      const fail = (error: Error) => {
        if (settled) { return; }
        void finish().then(() => {
          if (error instanceof AbortError) { this.writable.end(); }
          reject(error);
        });
      };
      unsubscribers.push(this.channel.on('execution:result', (frame) => {
        if (frame.requestId !== requestId) { fail(new Error('Execution result request id does not match')); return; }
        const data = frame.payloadUndefined ? undefined : frame.payload;
        void finish().then(() => resolveResult({ data }));
      }));
      unsubscribers.push(this.channel.on('execution:error', (frame) => {
        if (frame.requestId !== requestId) { fail(new Error('Execution error request id does not match')); return; }
        if (!isExecutionErrorPayload(frame.payload)) { fail(new Error('Execution error frame has an invalid payload')); return; }
        const errorPayload = frame.payload;
        void finish().then(() => reject(new SerializedErrorEnvelopeError(errorPayload.envelope, errorPayload.serializedError)));
      }));
      unsubscribers.push(this.channel.onError(fail));
      unsubscribers.push(this.channel.onClose(() => fail(new Error('Child control stream closed before execution completed'))));
      options?.signal?.addEventListener('abort', abortHandler, { once: true });
      if (options?.signal?.aborted) { abortHandler(); return; }
      const handlerRef = request.handlerRef.split('#', 1)[0] ?? request.handlerRef;
      const payload = {
        requestId,
        descriptor: request.descriptor as PluginContextDescriptor,
        handlerPath: handlerRef.startsWith('/') ? handlerRef : resolve(request.pluginRoot, handlerRef),
        input: request.input,
        cwd: request.workspace?.cwd ?? '/workspace',
        strictFilesystemPermissions: true,
        outdir: request.artifacts?.outdir,
      };
      void this.channel.send({ type: 'execution:start', requestId, payload }).catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

interface ExecutionErrorPayload {
  envelope: ErrorEnvelope;
  serializedError: SerializedError;
}

function isExecutionErrorPayload(value: unknown): value is ExecutionErrorPayload {
  if (typeof value !== 'object' || value === null) { return false; }
  const payload = value as Partial<ExecutionErrorPayload>;
  return typeof payload.envelope === 'object' && payload.envelope !== null
    && typeof payload.serializedError === 'object' && payload.serializedError !== null
    && typeof payload.serializedError.name === 'string'
    && typeof payload.serializedError.message === 'string';
}
