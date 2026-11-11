export const CLICKUP_BASE_PATH = '/v1/plugins/clickup' as const;

export const CLICKUP_ROUTES = {
  WORKSPACE:        '/workspace',
  TASKS_SEARCH:     '/tasks/search',
  TASK:             '/tasks/:taskId',
  TASKS_IN_LIST:    '/lists/:listId/tasks',
  LIST_STATUSES:    '/lists/:listId/statuses',
  TASK_COMMENTS:    '/tasks/:taskId/comments',
  // Spaces
  SPACES:           '/spaces',
  SPACE:            '/spaces/:spaceId',
  // Folders
  SPACE_FOLDERS:    '/spaces/:spaceId/folders',
  FOLDER:           '/folders/:folderId',
  // Lists
  SPACE_LISTS:      '/spaces/:spaceId/lists',
  FOLDER_LISTS:     '/folders/:folderId/lists',
  LIST:             '/lists/:listId',
} as const;

export const CLICKUP_FULL_ROUTES = {
  WORKSPACE:     `${CLICKUP_BASE_PATH}${CLICKUP_ROUTES.WORKSPACE}`,
  TASKS_SEARCH:  `${CLICKUP_BASE_PATH}${CLICKUP_ROUTES.TASKS_SEARCH}`,
  TASK:          `${CLICKUP_BASE_PATH}${CLICKUP_ROUTES.TASK}`,
  TASKS_IN_LIST: `${CLICKUP_BASE_PATH}${CLICKUP_ROUTES.TASKS_IN_LIST}`,
  LIST_STATUSES: `${CLICKUP_BASE_PATH}${CLICKUP_ROUTES.LIST_STATUSES}`,
  TASK_COMMENTS: `${CLICKUP_BASE_PATH}${CLICKUP_ROUTES.TASK_COMMENTS}`,
} as const;
