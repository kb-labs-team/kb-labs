import { combinePermissions } from '@kb-labs/sdk';
import { CLICKUP_BASE_PATH, CLICKUP_ROUTES } from './contracts/index.js';


const permissions = combinePermissions()
  .withEnv(['CLICKUP_API_KEY', 'CLICKUP_TEAM_ID'])
  .withNetwork({ fetch: ['api.clickup.com'] })
  .withQuotas({ timeoutMs: 30000, memoryMb: 128 })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/clickup',
  version: '0.1.0',

  display: {
    name: 'ClickUp',
    description: 'Manage ClickUp tasks, lists, and comments from CLI and REST API',
    tags: ['clickup', 'tasks', 'productivity'],
  },

  permissions,

  cli: {
    groupMeta: [
      { path: 'clickup',                describe: 'ClickUp task management' },
      { path: 'clickup task',           describe: 'Task operations' },
      { path: 'clickup task comments',  describe: 'Task comment operations' },
      { path: 'clickup list',           describe: 'List operations' },
      { path: 'clickup space',          describe: 'Space operations' },
      { path: 'clickup status',         describe: 'Status operations' },
      { path: 'clickup folder',         describe: 'Folder operations' },
    ],
    commands: [
      // ── Workspace ────────────────────────────────────────────────────────────
      {
        path: 'clickup workspace show',
        category: 'Workspace',
        operationType: 'read' as const,
        describe: 'Show full workspace hierarchy (spaces → folders → lists)',
        handler: './commands/workspace.js#default',
        flags: [
          { name: 'json', type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full', type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup workspace show',
          'kb clickup workspace show --json',
          'kb clickup workspace show --json --full',
        ],
      },

      // ── Tasks ─────────────────────────────────────────────────────────────────
      {
        path: 'clickup task search',
        category: 'Tasks',
        operationType: 'read' as const,
        describe: 'Search tasks across the workspace',
        handler: './commands/task-search.js#default',
        flags: [
          { name: 'list',     type: 'string',  description: 'Filter by list ID' },
          { name: 'status',   type: 'string',  description: 'Filter by status (comma-separated)' },
          { name: 'assignee', type: 'string',  description: 'Filter by assignee user IDs (comma-separated)' },
          { name: 'limit',    type: 'number',  description: 'Max results', default: 20 },
          { name: 'closed',   type: 'boolean', description: 'Include closed tasks' },
          { name: 'json',     type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',     type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task search "my bug"',
          'kb clickup task search --status "in progress" --json',
        ],
      },
      {
        path: 'clickup task get',
        category: 'Tasks',
        operationType: 'read' as const,
        describe: 'Get full task details including comments',
        handler: './commands/task-get.js#default',
        flags: [
          { name: 'json', type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full', type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task get abc123',
          'kb clickup task get abc123 --json',
        ],
      },
      {
        path: 'clickup task create',
        category: 'Tasks',
        operationType: 'mutate' as const,
        describe: 'Create a new task',
        handler: './commands/task-create.js#default',
        flags: [
          { name: 'list',     type: 'string',  description: 'Target list ID (required)' },
          { name: 'name',     type: 'string',  description: 'Task name (required)' },
          { name: 'desc',     type: 'string',  description: 'Task description' },
          { name: 'status',   type: 'string',  description: 'Initial status' },
          { name: 'priority', type: 'number',  description: '1=urgent 2=high 3=normal 4=low' },
          { name: 'assignee', type: 'string',  description: 'Assignee user IDs (comma-separated)' },
          { name: 'due',      type: 'string',  description: 'Due date (ISO string or unix ms)' },
          { name: 'json',     type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',     type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task create --list abc123 --name "Fix login bug" --priority 2',
          'kb clickup task create --list abc123 --name "Task" --json',
        ],
      },
      {
        path: 'clickup task update',
        category: 'Tasks',
        operationType: 'mutate' as const,
        describe: 'Update an existing task',
        handler: './commands/task-update.js#default',
        flags: [
          { name: 'name',         type: 'string',  description: 'New task name' },
          { name: 'desc',         type: 'string',  description: 'New description' },
          { name: 'status',       type: 'string',  description: 'New status' },
          { name: 'priority',     type: 'number',  description: '1=urgent 2=high 3=normal 4=low' },
          { name: 'assignee-add', type: 'string',  description: 'User IDs to add (comma-separated)' },
          { name: 'assignee-rem', type: 'string',  description: 'User IDs to remove (comma-separated)' },
          { name: 'due',          type: 'string',  description: 'Due date (ISO, unix ms, or "none")' },
          { name: 'json',         type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',         type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task update abc123 --status "in progress"',
          'kb clickup task update abc123 --priority 1 --json',
        ],
      },
      {
        path: 'clickup task delete',
        category: 'Tasks',
        operationType: 'mutate' as const,
        describe: 'Delete a task',
        handler: './commands/task-delete.js#default',
        flags: [
          { name: 'json', type: 'boolean', description: 'Output raw JSON' },
        ],
        examples: [
          'kb clickup task delete abc123 --yes',
          'kb clickup task delete abc123 --dry-run',
        ],
      },

      // ── Comments ─────────────────────────────────────────────────────────────
      {
        path: 'clickup task comments list',
        category: 'Comments',
        operationType: 'read' as const,
        describe: 'List comments on a task',
        handler: './commands/task-comment-list.js#default',
        flags: [
          { name: 'json', type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full', type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task comments list abc123',
          'kb clickup task comments list abc123 --json',
        ],
      },
      {
        path: 'clickup task comments add',
        category: 'Comments',
        operationType: 'mutate' as const,
        describe: 'Add a comment to a task',
        handler: './commands/task-comment-add.js#default',
        flags: [
          { name: 'text',    type: 'string',  description: 'Comment text (required)' },
          { name: 'assignee',type: 'number',  description: 'Assign comment to user ID' },
          { name: 'notify',  type: 'boolean', description: 'Notify all task watchers' },
          { name: 'json',    type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',    type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task comments add abc123 --text "Fixed in branch feature/x"',
        ],
      },

      // ── Spaces ───────────────────────────────────────────────────────────────
      {
        path: 'clickup space create',
        category: 'Spaces',
        operationType: 'mutate' as const,
        describe: 'Create a new space',
        handler: './commands/space-create.js#default',
        flags: [
          { name: 'name',    type: 'string',  description: 'Space name (required)' },
          { name: 'color',   type: 'string',  description: 'Space color (hex)' },
          { name: 'private', type: 'boolean', description: 'Make space private' },
          { name: 'json',    type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',    type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup space create --name "Engineering"',
          'kb clickup space create --name "Design" --color "#ff0000"',
        ],
      },
      {
        path: 'clickup space update',
        category: 'Spaces',
        operationType: 'mutate' as const,
        describe: 'Update a space',
        handler: './commands/space-update.js#default',
        flags: [
          { name: 'name',  type: 'string',  description: 'New space name' },
          { name: 'color', type: 'string',  description: 'New color (hex)' },
          { name: 'json',  type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',  type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup space update spaceId --name "Backend"',
        ],
      },
      {
        path: 'clickup space delete',
        category: 'Spaces',
        operationType: 'mutate' as const,
        describe: 'Delete a space',
        handler: './commands/space-delete.js#default',
        flags: [
          { name: 'force', type: 'boolean', description: 'Skip confirmation' },
          { name: 'json',  type: 'boolean', description: 'Output raw JSON' },
        ],
        examples: [
          'kb clickup space delete spaceId --force',
        ],
      },

      // ── Folders ───────────────────────────────────────────────────────────────
      {
        path: 'clickup folder create',
        category: 'Folders',
        operationType: 'mutate' as const,
        describe: 'Create a new folder in a space',
        handler: './commands/folder-create.js#default',
        flags: [
          { name: 'space', type: 'string',  description: 'Space ID (required)' },
          { name: 'name',  type: 'string',  description: 'Folder name (required)' },
          { name: 'json',  type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',  type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup folder create --space spaceId --name "Q3 Sprint"',
        ],
      },
      {
        path: 'clickup folder update',
        category: 'Folders',
        operationType: 'mutate' as const,
        describe: 'Rename a folder',
        handler: './commands/folder-update.js#default',
        flags: [
          { name: 'name', type: 'string',  description: 'New folder name (required)' },
          { name: 'json', type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full', type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup folder update folderId --name "Q4 Sprint"',
        ],
      },
      {
        path: 'clickup folder delete',
        category: 'Folders',
        operationType: 'mutate' as const,
        describe: 'Delete a folder',
        handler: './commands/folder-delete.js#default',
        flags: [
          { name: 'force', type: 'boolean', description: 'Skip confirmation' },
          { name: 'json',  type: 'boolean', description: 'Output raw JSON' },
        ],
        examples: [
          'kb clickup folder delete folderId --force',
        ],
      },

      // ── List CRUD ─────────────────────────────────────────────────────────────
      {
        path: 'clickup list create',
        category: 'Lists',
        operationType: 'mutate' as const,
        describe: 'Create a new list in a folder or space',
        handler: './commands/list-create.js#default',
        flags: [
          { name: 'folder', type: 'string',  description: 'Folder ID (use instead of --space)' },
          { name: 'space',  type: 'string',  description: 'Space ID for folderless list' },
          { name: 'name',   type: 'string',  description: 'List name (required)' },
          { name: 'json',   type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',   type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup list create --folder folderId --name "Backlog"',
          'kb clickup list create --space spaceId --name "Inbox"',
        ],
      },
      {
        path: 'clickup list update',
        category: 'Lists',
        operationType: 'mutate' as const,
        describe: 'Update a list',
        handler: './commands/list-update.js#default',
        flags: [
          { name: 'name', type: 'string',  description: 'New list name' },
          { name: 'json', type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full', type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup list update listId --name "Sprint 5"',
        ],
      },
      {
        path: 'clickup list delete',
        category: 'Lists',
        operationType: 'mutate' as const,
        describe: 'Delete a list',
        handler: './commands/list-delete.js#default',
        flags: [
          { name: 'force', type: 'boolean', description: 'Skip confirmation' },
          { name: 'json',  type: 'boolean', description: 'Output raw JSON' },
        ],
        examples: [
          'kb clickup list delete listId --force',
        ],
      },

      // ── List ─────────────────────────────────────────────────────────────────
      {
        path: 'clickup task list',
        category: 'Lists',
        operationType: 'read' as const,
        describe: 'List tasks in a specific list',
        handler: './commands/list-tasks.js#default',
        flags: [
          { name: 'status',   type: 'string',  description: 'Filter by status (comma-separated)' },
          { name: 'assignee', type: 'string',  description: 'Filter by user IDs (comma-separated)' },
          { name: 'limit',    type: 'number',  description: 'Max results', default: 50 },
          { name: 'page',     type: 'number',  description: 'Page number', default: 0 },
          { name: 'closed',   type: 'boolean', description: 'Include closed tasks' },
          { name: 'json',     type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full',     type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup task list listId123',
          'kb clickup task list listId123 --status "open" --json',
        ],
      },
      {
        path: 'clickup status list',
        category: 'Lists',
        operationType: 'read' as const,
        describe: 'List available statuses for a list',
        handler: './commands/list-statuses.js#default',
        flags: [
          { name: 'json', type: 'boolean', description: 'Output JSON (slim by default)' },
          { name: 'full', type: 'boolean', description: 'Output full raw JSON (requires --json)' },
        ],
        examples: [
          'kb clickup status list listId123',
          'kb clickup status list listId123 --json',
        ],
      },
    ],
  },

  rest: {
    basePath: CLICKUP_BASE_PATH,
    routes: [
      {
        method: 'GET',
        path: CLICKUP_ROUTES.WORKSPACE,
        handler: './rest/handlers/workspace-handler.js#default',
      },
      {
        method: 'GET',
        path: CLICKUP_ROUTES.TASKS_SEARCH,
        handler: './rest/handlers/search-handler.js#default',
      },
      {
        method: 'GET',
        path: CLICKUP_ROUTES.TASK,
        handler: './rest/handlers/task-get-handler.js#default',
      },
      {
        method: 'POST',
        path: CLICKUP_ROUTES.TASKS_IN_LIST,
        handler: './rest/handlers/task-create-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#CreateTaskSchema' },
      },
      {
        method: 'PATCH',
        path: CLICKUP_ROUTES.TASK,
        handler: './rest/handlers/task-update-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#UpdateTaskSchema' },
      },
      {
        method: 'DELETE',
        path: CLICKUP_ROUTES.TASK,
        handler: './rest/handlers/task-delete-handler.js#default',
      },
      {
        method: 'GET',
        path: CLICKUP_ROUTES.TASKS_IN_LIST,
        handler: './rest/handlers/list-tasks-handler.js#default',
      },
      {
        method: 'GET',
        path: CLICKUP_ROUTES.LIST_STATUSES,
        handler: './rest/handlers/list-statuses-handler.js#default',
      },
      {
        method: 'GET',
        path: CLICKUP_ROUTES.TASK_COMMENTS,
        handler: './rest/handlers/task-comments-handler.js#default',
      },
      {
        method: 'POST',
        path: CLICKUP_ROUTES.TASK_COMMENTS,
        handler: './rest/handlers/task-comment-add-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#AddCommentSchema' },
      },
      // ── Spaces
      {
        method: 'POST',
        path: CLICKUP_ROUTES.SPACES,
        handler: './rest/handlers/space-create-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#CreateSpaceSchema' },
      },
      {
        method: 'PATCH',
        path: CLICKUP_ROUTES.SPACE,
        handler: './rest/handlers/space-update-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#UpdateSpaceSchema' },
      },
      {
        method: 'DELETE',
        path: CLICKUP_ROUTES.SPACE,
        handler: './rest/handlers/space-delete-handler.js#default',
      },
      // ── Folders
      {
        method: 'POST',
        path: CLICKUP_ROUTES.SPACE_FOLDERS,
        handler: './rest/handlers/folder-create-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#CreateFolderSchema' },
      },
      {
        method: 'PATCH',
        path: CLICKUP_ROUTES.FOLDER,
        handler: './rest/handlers/folder-update-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#UpdateFolderSchema' },
      },
      {
        method: 'DELETE',
        path: CLICKUP_ROUTES.FOLDER,
        handler: './rest/handlers/folder-delete-handler.js#default',
      },
      // ── Lists CRUD
      {
        method: 'POST',
        path: CLICKUP_ROUTES.FOLDER_LISTS,
        handler: './rest/handlers/list-create-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#CreateListSchema' },
      },
      {
        method: 'POST',
        path: CLICKUP_ROUTES.SPACE_LISTS,
        handler: './rest/handlers/list-create-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#CreateListSchema' },
      },
      {
        method: 'PATCH',
        path: CLICKUP_ROUTES.LIST,
        handler: './rest/handlers/list-update-handler.js#default',
        input: { zod: '@kb-labs/clickup/contracts#UpdateListSchema' },
      },
      {
        method: 'DELETE',
        path: CLICKUP_ROUTES.LIST,
        handler: './rest/handlers/list-delete-handler.js#default',
      },
    ],
  },
};
