export const INBOX_BASE_PATH = '/v1/plugins/inbox' as const;

export const INBOX_ROUTES = {
  MESSAGES:       '/messages',
  MESSAGE:        '/messages/:uid',
  MESSAGE_THREAD: '/messages/:uid/thread',
  MESSAGE_REPLY:  '/messages/:uid/reply',
  MESSAGE_MOVE:   '/messages/:uid/move',
  MESSAGE_MARK:   '/messages/:uid/mark',
  SEARCH:         '/search',
  FOLDERS:        '/folders',
  ACCOUNTS:       '/accounts',
} as const;
