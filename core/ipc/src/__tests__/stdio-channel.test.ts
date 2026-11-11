import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createStdioChannel, StdioFrameDecoder, encodeStdioFrame } from '../transport/stdio-channel.js';

describe('stdio framed channel', () => {
  it('round-trips a length-prefixed JSON frame', () => {
    const frame = { type: 'execution:start', requestId: 'r1', payload: { handler: 'src/index.js' } } as const;
    const encoded = encodeStdioFrame(frame);
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4);
    expect(new StdioFrameDecoder().push(encoded)).toEqual([frame]);
  });

  it('preserves an undefined execution result across JSON framing', () => {
    const encoded = encodeStdioFrame({ type: 'execution:result', requestId: 'r-undefined', payload: undefined });
    expect(new StdioFrameDecoder().push(encoded)).toEqual([
      { type: 'execution:result', requestId: 'r-undefined', payload: null, payloadUndefined: true },
    ]);
  });

  it('decodes partial header and payload reads', () => {
    const encoded = encodeStdioFrame({ type: 'platform:request', requestId: 'rpc1', payload: { op: 'cache.get' } });
    const decoder = new StdioFrameDecoder();
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2, 7))).toEqual([]);
    expect(decoder.push(encoded.subarray(7))).toEqual([
      { type: 'platform:request', requestId: 'rpc1', payload: { op: 'cache.get' } },
    ]);
  });

  it('dispatches interleaved control, platform and log frames in wire order', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = createStdioChannel(input, output);
    const seen: string[] = [];
    channel.on('execution:result', (frame) => { seen.push(frame.requestId); });
    channel.on('runtime:ready', () => { seen.push('ready'); });
    channel.on('platform:request', (frame) => { seen.push(frame.requestId); });
    channel.on('log', (frame) => { seen.push(frame.message); });
    input.write(Buffer.concat([
      encodeStdioFrame({ type: 'execution:result', requestId: 'exec1', payload: 42 }),
      encodeStdioFrame({ type: 'runtime:ready' }),
      encodeStdioFrame({ type: 'platform:request', requestId: 'rpc1', payload: { op: 'ws.send' } }),
      encodeStdioFrame({ type: 'log', level: 'info', message: 'hello', stream: 'stdout' }),
    ]));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(seen).toEqual(['exec1', 'ready', 'rpc1', 'hello']);
    channel.close();
    input.destroy();
    output.destroy();
  });

  it('refuses a frame larger than the protocol limit with a catalogued error', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1024 * 1024 * 16);
    try {
      new StdioFrameDecoder().push(header);
      throw new Error('Expected oversized frame rejection');
    } catch (error) {
      expect(error).toMatchObject({ envelope: { code: 'KB_RUNTIME_FRAME_TOO_LARGE' } });
    }
  });

  it('rejects raw stdout bytes instead of accepting a corrupted stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = createStdioChannel(input, output);
    const rejected = new Promise<Error>((resolve) => { channel.onError(resolve); });
    input.write('unexpected raw line\n');
    await expect(rejected).resolves.toMatchObject({
      envelope: { code: 'KB_RUNTIME_FRAME_TOO_LARGE' },
    });
    channel.close();
    input.destroy();
    output.destroy();
  });
});
