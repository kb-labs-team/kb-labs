import { afterEach, describe, expect, it, vi } from 'vitest';
import { VibeProxyLLM } from './llm.js';

describe('VibeProxy provider errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // case: S-189.5
  it('preserves an authentication response status for Gateway error classification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'The mock provider rejected the journey API key.' },
    }), { status: 401 })));
    const adapter = new VibeProxyLLM({ baseURL: 'http://provider.test', apiKey: 'fixture-key' });

    await expect(adapter.complete('journey-provider-401')).rejects.toMatchObject({ status: 401 });
  });

  // case: S-189.5
  it('yields a Messages stream chunk before surfacing its terminal provider error', async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"The mock provider is temporarily unavailable."}}\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const adapter = new VibeProxyLLM({ baseURL: 'http://provider.test', apiKey: 'fixture-key' });
    const stream = adapter.stream('journey-provider-stream-error')[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toEqual({ value: 'partial', done: false });
    await expect(stream.next()).rejects.toThrow('The mock provider is temporarily unavailable.');
  });
});
