import { vi } from 'vitest';

vi.mock('../../src/core/index.js', () => ({
  resolveAccount: vi.fn(() => ({ name: 'work' })),
  listAccounts: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
  listFolders: vi.fn(async () => []),
  getMessage: vi.fn(async () => ({})),
  getThread: vi.fn(async () => []),
  searchMessages: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({ messageId: 'sent' })),
  replyMessage: vi.fn(async () => ({ messageId: 'replied' })),
  deleteMessage: vi.fn(async () => undefined),
  moveMessage: vi.fn(async () => undefined),
  markMessage: vi.fn(async () => undefined),
}));
