/** Shared framed stdio protocol used by subprocess and container execution. */

import type { Readable, Writable } from 'node:stream';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';

export const MAX_STDIO_FRAME_BYTES = 8 * 1024 * 1024;

export type StdioFrame =
  | { type: 'execution:start'; requestId: string; payload: unknown }
  | { type: 'execution:result'; requestId: string; payload: unknown; payloadUndefined?: true }
  | { type: 'execution:error'; requestId: string; payload: unknown }
  | { type: 'execution:cancel'; requestId: string }
  | { type: 'runtime:ready' }
  | { type: 'platform:request'; requestId: string; payload: unknown }
  | { type: 'platform:cancel'; requestId: string }
  | { type: 'platform:response'; requestId: string; payload: unknown }
  | { type: 'platform:message'; payload: unknown }
  | { type: 'platform:push'; payload: unknown }
  | { type: 'log'; level: string; message: string; stream: 'stdout' | 'stderr'; meta?: Record<string, unknown> };

export type StdioFrameType = StdioFrame['type'];
export type StdioFrameOf<T extends StdioFrameType> = Extract<StdioFrame, { type: T }>;

function frameTooLarge(actual: number): ErrorEnvelopeError {
  return new ErrorEnvelopeError(createErrorEnvelope('KB_RUNTIME_FRAME_TOO_LARGE', {
    details: { actualBytes: String(actual), maximumBytes: String(MAX_STDIO_FRAME_BYTES) },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStdioFrame(value: unknown): value is StdioFrame {
  if (!isRecord(value) || typeof value.type !== 'string') { return false; }
  switch (value.type) {
    case 'execution:start':
    case 'execution:result':
    case 'execution:error':
    case 'platform:request':
    case 'platform:response':
      return typeof value.requestId === 'string' && 'payload' in value
        && (value.type !== 'execution:result' || value.payloadUndefined === undefined || value.payloadUndefined === true);
    case 'execution:cancel':
    case 'platform:cancel':
      return typeof value.requestId === 'string';
    case 'runtime:ready':
      return true;
    case 'platform:message':
    case 'platform:push':
      return 'payload' in value;
    case 'log':
      return typeof value.level === 'string'
        && typeof value.message === 'string'
        && (value.stream === 'stdout' || value.stream === 'stderr');
    default:
      return false;
  }
}

/** Encode one JSON message as a 4-byte big-endian length followed by UTF-8 JSON. */
export function encodeStdioFrame(frame: StdioFrame): Buffer {
  const serializable = frame.type === 'execution:result' && frame.payload === undefined
    ? { ...frame, payload: null, payloadUndefined: true }
    : frame;
  const payload = Buffer.from(JSON.stringify(serializable), 'utf8');
  if (payload.byteLength > MAX_STDIO_FRAME_BYTES) { throw frameTooLarge(payload.byteLength); }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder; accepts arbitrary partial or coalesced stream chunks. */
export class StdioFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): StdioFrame[] {
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, chunk]);
    const frames: StdioFrame[] = [];
    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32BE(0);
      if (payloadLength > MAX_STDIO_FRAME_BYTES) { throw frameTooLarge(payloadLength); }
      if (this.buffer.length < payloadLength + 4) { break; }
      const payload = this.buffer.subarray(4, payloadLength + 4).toString('utf8');
      this.buffer = this.buffer.subarray(payloadLength + 4);
      const parsed: unknown = JSON.parse(payload);
      if (!isStdioFrame(parsed)) { throw new Error('Invalid stdio control frame'); }
      frames.push(parsed);
    }
    return frames;
  }
}

/** Duplex stream with one typed dispatch table for every protocol message. */
export class StdioChannel {
  private readonly decoder = new StdioFrameDecoder();
  private readonly handlers = new Map<StdioFrameType, Set<(frame: StdioFrame) => void>>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly dataHandler: (chunk: Buffer) => void;
  private readonly endHandler: () => void;
  private readonly writableErrorHandler: (error: Error) => void;
  private readonly writableCloseHandler: () => void;
  private readonly writableFinishHandler: () => void;
  private readonly pendingWrites = new Set<(error: Error) => void>();
  private closed = false;

  constructor(private readonly readable: Readable, private readonly writable: Writable) {
    this.dataHandler = (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          for (const handler of this.handlers.get(frame.type) ?? []) { handler(frame); }
        }
      } catch (error) {
        const protocolError = error instanceof Error ? error : new Error(String(error));
        for (const handler of this.errorHandlers) { handler(protocolError); }
        this.markClosed();
      }
    };
    this.endHandler = () => { this.markClosed(); };
    this.writableErrorHandler = (error) => {
      if (this.closed) { return; }
      for (const handler of this.errorHandlers) { handler(error); }
      this.markClosed(error);
    };
    this.writableCloseHandler = () => { this.releaseWritableErrorOwner(); };
    this.writableFinishHandler = () => { this.releaseWritableErrorOwner(); };
    readable.on('data', this.dataHandler);
    readable.on('end', this.endHandler);
    // Writable streams emit asynchronous errors even when a particular write
    // has a callback. Keep an owner attached for the lifetime of the channel.
    writable.on('error', this.writableErrorHandler);
    writable.on('close', this.writableCloseHandler);
    writable.on('finish', this.writableFinishHandler);
  }

  send(frame: StdioFrame): Promise<void> {
    if (this.closed || this.writable.destroyed) { return Promise.reject(new Error('Stdio channel is closed')); }
    const data = encodeStdioFrame(frame);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) { return; }
        settled = true;
        this.pendingWrites.delete(fail);
        if (error) { reject(error); } else { resolve(); }
      };
      const fail = (error: Error) => settle(error);
      this.pendingWrites.add(fail);
      try {
        // The per-write callback observes asynchronous EPIPE/closed-pipe
        // failures. The return value only reports queue backpressure; retrying
        // would duplicate the frame, so completion is tracked by this callback.
        this.writable.write(data, (error?: Error | null) => {
          if (error) {
            this.writableErrorHandler(error);
            settle(error);
          } else {
            settle();
          }
        });
      } catch (error) {
        const writeError = error instanceof Error ? error : new Error(String(error));
        this.writableErrorHandler(writeError);
        settle(writeError);
      }
    });
  }

  on<T extends StdioFrameType>(type: T, handler: (frame: StdioFrameOf<T>) => void): () => void {
    let typedHandlers = this.handlers.get(type);
    if (!typedHandlers) {
      typedHandlers = new Set();
      this.handlers.set(type, typedHandlers);
    }
    const frameHandler = handler as (frame: StdioFrame) => void;
    typedHandlers.add(frameHandler);
    return () => { typedHandlers?.delete(frameHandler); };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => { this.errorHandlers.delete(handler); };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  close(): void {
    if (this.closed) { return; }
    this.markClosed();
    this.readable.off('data', this.dataHandler);
    this.readable.off('end', this.endHandler);
    // Pending writes can fail asynchronously after the protocol channel has
    // closed. Retain the error owner until the Writable itself is done.
    if (this.writable.closed || this.writable.writableFinished) { this.releaseWritableErrorOwner(); }
    this.handlers.clear();
    this.errorHandlers.clear();
    this.closeHandlers.clear();
  }

  private markClosed(error = new Error('Stdio channel is closed')): void {
    if (this.closed) { return; }
    this.closed = true;
    for (const fail of this.pendingWrites) { fail(error); }
    for (const handler of this.closeHandlers) { handler(); }
  }

  private releaseWritableErrorOwner(): void {
    this.writable.off('error', this.writableErrorHandler);
    this.writable.off('close', this.writableCloseHandler);
    this.writable.off('finish', this.writableFinishHandler);
  }
}

export function createStdioChannel(readable: Readable, writable: Writable): StdioChannel {
  return new StdioChannel(readable, writable);
}
