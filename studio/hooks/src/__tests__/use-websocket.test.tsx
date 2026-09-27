import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from '../use-websocket';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  send = vi.fn();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  emitClose(code: number) {
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('useWebSocket', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    MockWebSocket.instances = [];
  });

  it('does not reconnect a stale socket after its URL changes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);

    const { rerender, unmount } = renderHook(
      ({ url }: { url: string }) => useWebSocket(url, {
        reconnect: true,
        maxReconnects: 2,
        reconnectIntervalMs: 1,
      }),
      { initialProps: { url: 'ws://localhost/session/old' } },
    );

    const staleSocket = MockWebSocket.instances[0]!;
    rerender({ url: 'ws://localhost/session/new' });
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => staleSocket.emitClose(1001));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]!.url).toBe('ws://localhost/session/new');
    unmount();
  });
});
