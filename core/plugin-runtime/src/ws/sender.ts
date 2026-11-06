import { createErrorEnvelope, ErrorEnvelopeError, getAdapterConfigurationCommand } from '@kb-labs/core-platform';
import type { IWebSocketHostOperations } from '@kb-labs/core-platform/adapters';
import type { WSConnectionReference, WSInputReference, WSMessage, WSSender } from '@kb-labs/plugin-contracts';

/** Rehydrate the handler-only sender after the execution boundary. */
export function createWSSender(reference: WSConnectionReference, operations: IWebSocketHostOperations): WSSender {
  return {
    async send(message: WSMessage) {
      await operations.send(reference.connectionId, message);
    },
    async broadcast(message: WSMessage, excludeSelf = true) {
      await operations.broadcast(reference.connectionId, message, excludeSelf);
    },
    async sendTo(connectionIds: string[], message: WSMessage) {
      await operations.sendTo(reference.connectionId, connectionIds, message);
    },
    async close(code?: number, reason?: string) {
      await operations.close(reference.connectionId, code, reason);
    },
    async getConnectionId() {
      return operations.getConnectionId(reference.connectionId);
    },
  };
}

/** Build the runtime-only sender from the serialized WebSocket input reference. */
export function rehydrateWSInput(input: WSInputReference, operations: IWebSocketHostOperations | undefined) {
  if (input.event === 'disconnect') {return input;}
  if (!operations) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_ADAPTER_NOT_CONFIGURED', {
      details: { service: 'websocket', adapter: 'websocket', command: getAdapterConfigurationCommand('websocket') },
    }));
  }
  return { ...input, sender: createWSSender(input.connection, operations) };
}
