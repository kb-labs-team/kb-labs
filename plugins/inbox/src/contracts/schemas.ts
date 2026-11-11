import { z } from 'zod';

export const SendMessageSchema = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  account: z.string().optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const ReplyMessageSchema = z.object({
  body: z.string().min(1),
  account: z.string().optional(),
});
export type ReplyMessageInput = z.infer<typeof ReplyMessageSchema>;

export const MoveMessageSchema = z.object({
  folder: z.string().min(1),
  account: z.string().optional(),
});
export type MoveMessageInput = z.infer<typeof MoveMessageSchema>;

export const MarkMessageSchema = z.object({
  mark: z.enum(['read', 'unread', 'spam', 'flagged', 'unflagged']),
  account: z.string().optional(),
});
export type MarkMessageInput = z.infer<typeof MarkMessageSchema>;
