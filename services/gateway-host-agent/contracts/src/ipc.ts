import { z } from 'zod';

/**
 * IPC protocol over Unix socket (~/.kb/agent.sock)
 * Used by CLI/Studio to talk to the local daemon.
 */

export const IpcExecuteRequestSchema = z.object({
  type: z.literal('execute'),
  requestId: z.string(),
  command: z.string(),
  params: z.record(z.unknown()).optional(),
  stream: z.boolean().default(false),
});
export type IpcExecuteRequest = z.infer<typeof IpcExecuteRequestSchema>;

export const IpcEventMessageSchema = z.object({
  type: z.literal('event'),
  requestId: z.string(),
  data: z.unknown(),
});
export type IpcEventMessage = z.infer<typeof IpcEventMessageSchema>;

export const IpcDoneMessageSchema = z.object({
  type: z.literal('done'),
  requestId: z.string(),
  result: z.unknown(),
});
export type IpcDoneMessage = z.infer<typeof IpcDoneMessageSchema>;

export const IpcErrorMessageSchema = z.object({
  type: z.literal('error'),
  requestId: z.string(),
  code: z.string(),
  message: z.string(),
});
export type IpcErrorMessage = z.infer<typeof IpcErrorMessageSchema>;

export const IpcCancelRequestSchema = z.object({
  type: z.literal('cancel'),
  executionId: z.string(),
  reason: z.string().default('user'),
});
export type IpcCancelRequest = z.infer<typeof IpcCancelRequestSchema>;

export const IpcStatusRequestSchema = z.object({
  type: z.literal('status'),
});
export type IpcStatusRequest = z.infer<typeof IpcStatusRequestSchema>;

export const IpcStatusResponseSchema = z.object({
  type: z.literal('status'),
  connected: z.boolean(),
  hostId: z.string().optional(),
  gatewayUrl: z.string().optional(),
  latencyMs: z.number().optional(),
  reconnecting: z.boolean().default(false),
});
export type IpcStatusResponse = z.infer<typeof IpcStatusResponseSchema>;

export type IpcRequest = IpcExecuteRequest | IpcCancelRequest | IpcStatusRequest;
export type IpcResponse = IpcEventMessage | IpcDoneMessage | IpcErrorMessage | IpcStatusResponse;
