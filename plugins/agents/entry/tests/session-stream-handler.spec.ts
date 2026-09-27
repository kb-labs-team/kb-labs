import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IEventBus } from '@kb-labs/core-platform';
import type { PluginContextV3, WSInput, WSSender, WSMessage } from '@kb-labs/plugin-contracts';

const { getProjectionMock } = vi.hoisted(() => ({ getProjectionMock: vi.fn() }));
vi.mock('@kb-labs/agent-core', () => ({
  SessionManager: class {
    getProjection = getProjectionMock;
  },
}));

import sessionStreamHandler from '../src/ws/session-stream-handler.js';

describe('session stream WebSocket handler', () => {
  beforeEach(() => {
    getProjectionMock.mockReset();
    getProjectionMock.mockResolvedValue({ turns: [], seq: 0 });
  });

  it('routes cross-context session events and releases the subscription with close details', async () => {
    let subscriber: ((event: unknown) => Promise<void>) | undefined;
    const unsubscribe = vi.fn();
    const info = vi.fn();
    const error = vi.fn();
    const sent: unknown[] = [];
    const bus: IEventBus = {
      publish: async () => undefined,
      subscribe: (_topic, handler) => {
        subscriber = handler as (event: unknown) => Promise<void>;
        return unsubscribe;
      },
    };
    const sender = {
      send: async (message: WSMessage) => { sent.push(message); },
      broadcast: async () => undefined,
      sendTo: async () => undefined,
      close: () => undefined,
      getConnectionId: () => 'connection-1',
    } as unknown as WSSender;
    const platform = { eventBus: bus, logger: { info, error } };
    const connectedContext = {
      host: 'ws',
      cwd: '/workspace',
      hostContext: {
        host: 'ws',
        channelPath: '/session/:sessionId',
        connectionId: 'connection-1',
        params: { sessionId: 'session-1' },
      },
      platform,
    } as unknown as PluginContextV3;

    await sessionStreamHandler.execute(connectedContext, {
      event: 'connect',
      sender,
    } as WSInput);

    expect(subscriber).toBeDefined();
    expect(sent).toHaveLength(2);
    await subscriber?.({ kind: 'cursor', seq: 1 });
    expect(sent[2]).toMatchObject({ type: 'session:cursor', payload: { seq: 1 } });
    await subscriber?.({
      kind: 'run:completed',
      runId: 'run-1',
      success: true,
      summary: 'pong',
      durationMs: 100,
      seq: 1,
    });
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({ type: 'run:completed', payload: { summary: 'pong' } });

    const disconnectContext = {
      ...connectedContext,
      hostContext: { ...connectedContext.hostContext },
    } as PluginContextV3;
    await sessionStreamHandler.execute(disconnectContext, {
      event: 'disconnect',
      disconnectCode: 1006,
      disconnectReason: 'abnormal closure',
    } as WSInput);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('[session-ws] Client disconnected from session', expect.objectContaining({
      event: 'agent.session.websocket.disconnected',
      sessionId: 'session-1',
      connectionId: 'connection-1',
      closeCode: 1006,
      closeReason: 'abnormal closure',
      subscriptionFound: true,
    }));
  });
});
