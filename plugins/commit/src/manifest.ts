/**
 * KB Labs Commit Plugin - Manifest V3
 *
 * Migration from V2 to V3 following best practices from V3-MIGRATION-GUIDE.md
 *
 * Key changes:
 * - Schema: kb.plugin/3
 * - Commands use handler#default suffix
 * - Commands have handlerPath field
 * - All imports from @kb-labs/sdk
 */

import {
  defineCommandFlags,
  combinePermissions,
  gitWorkflowPreset,
  kbPlatformPreset,
} from '@kb-labs/sdk';
import {
  COMMIT_ENV_VARS,
  COMMIT_BASE_PATH,
  COMMIT_ROUTES,
  COMMIT_CACHE_PREFIX,
  defaultCommitConfig,
} from './contracts/index.js';
import {
  runFlags,
  generateFlags,
  applyFlags,
  pushFlags,
  jsonOnlyFlags,
} from './cli/commands/flags';

/**
 * Build permissions using presets:
 * - gitWorkflow: HOME, USER, GIT_*, SSH_* for git operations
 * - kbPlatform: KB_* env vars and .kb/ directory
 * - Custom: COMMIT_ENV_VARS, quotas, platform services (llm, cache)
 *
 * Note: LLM access goes through platform services, no direct API keys needed.
 */
const pluginPermissions = combinePermissions()
  .with(gitWorkflowPreset)
  .with(kbPlatformPreset)
  .withEnv([...COMMIT_ENV_VARS])
  .withFs({
    mode: 'readWrite',
    allow: ['.kb/commit/**'],
  })
  .withPlatform({
    llm: true,              // Full LLM access for commit generation
    cache: [COMMIT_CACHE_PREFIX], // Cache namespace prefix from contracts
    analytics: true,        // Track commit generation events
  })
  .withQuotas({
    timeoutMs: 600000, // 10 min for LLM
    memoryMb: 512,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/commit',
  version: '0.1.0',
  configSection: 'commit',
  settings: {
    defaults: defaultCommitConfig,
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        llm: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            temperature: { type: 'number', minimum: 0, maximum: 1 },
            maxTokens: { type: 'integer', minimum: 1 },
          },
          required: ['enabled', 'temperature', 'maxTokens'],
          additionalProperties: false,
        },
        storage: {
          type: 'object',
          properties: { directory: { type: 'string', minLength: 1 } },
          required: ['directory'],
          additionalProperties: false,
        },
        git: {
          type: 'object',
          properties: {
            protectedBranches: { type: 'array', items: { type: 'string' } },
            autoStage: { type: 'boolean' },
          },
          required: ['protectedBranches', 'autoStage'],
          additionalProperties: false,
        },
        scope: {
          type: 'object',
          properties: {
            default: { type: 'string' },
            scopes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', minLength: 1 },
                  label: { type: 'string', minLength: 1 },
                  path: { type: 'string', minLength: 1 },
                  description: { type: 'string' },
                },
                required: ['id', 'label', 'path'],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      required: ['enabled', 'llm', 'storage', 'git'],
      additionalProperties: false,
    },
  },

  display: {
    name: 'Commit Generator',
    description: 'AI-powered conventional commit generation',
    tags: ['commit', 'git', 'ai', 'conventional-commits'],
  },

  // Platform requirements (LLM is optional but preferred)
  platform: {
    requires: ['storage', 'cache'],
    optional: ['llm', 'analytics', 'logger'],
  },

  // TODO: Implement V3 setup handler
  // Setup temporarily disabled during migration - needs proper V3 implementation
  // setup: {
  //   handler: './lifecycle/setup.js#default',
  //   handlerPath: './lifecycle/setup.js',
  //   describe: 'Initialize .kb/commit/ directory structure.',
  //   permissions: permissions.combine(
  //     permissions.presets.pluginWorkspace('commit'),
  //     {
  //       quotas: { timeoutMs: 10000, memoryMb: 128, cpuMs: 3000 },
  //     }
  //   ),
  // },

  // V3: cli wrapper with commands array
  cli: {
    groupMeta: [
      {
        path: 'commit',
        describe: 'AI-powered conventional commit generation.',
      },
      {
        path: 'commit plan',
        describe: 'Commit plan management.',
      },
    ],
    commands: [
      // Main command: commit (default flow)
      {
        path: 'commit commit',
        category: 'Pipeline',
        describe: 'Generate and apply commits (default flow).',
        operationType: 'execute' as const,
        longDescription:
          'Analyzes changes, generates commit plan with LLM, applies commits locally. ' +
          'Use --dry-run to preview without applying, --with-push to push after applying.',

        // ✅ V3: handler with #default suffix
        handler: './cli/commands/run.js#default',

        flags: defineCommandFlags(runFlags),

        examples: [
          'kb commit commit',
          'kb commit commit --dry-run',
          'kb commit commit --with-push',
          'kb commit commit --scope "src/components/**"',
        ],
      },

      // commit:generate - Generate commit plan
      {
        path: 'commit plan create',
        category: 'Pipeline',
        describe: 'Generate commit plan from git changes.',
        operationType: 'execute' as const,
        longDescription:
          'Analyzes staged and unstaged changes using git diff, then uses LLM to group ' +
          'related changes and generate conventional commit messages.',

        handler: './cli/commands/generate.js#default',

        flags: defineCommandFlags(generateFlags),

        examples: [
          'kb commit plan create',
          'kb commit plan create --json',
          'kb commit plan create --scope "packages/**"',
        ],
      },

      // commit:apply - Apply commit plan
      {
        path: 'commit plan apply',
        category: 'Pipeline',
        describe: 'Apply current commit plan (create local commits).',
        operationType: 'mutate' as const,
        longDescription:
          'Creates git commits according to the current plan. Checks for staleness ' +
          '(working tree changes since plan generation) unless --force is used.',

        handler: './cli/commands/apply.js#default',

        flags: defineCommandFlags(applyFlags),

        examples: [
          'kb commit plan apply',
          'kb commit plan apply --force',
        ],
      },

      // commit:push - Push commits
      {
        path: 'commit publish',
        category: 'Pipeline',
        describe: 'Push commits to remote repository.',
        operationType: 'execute' as const,
        longDescription:
          'Pushes local commits to the remote. Refuses force push to protected branches ' +
          '(main, master) by default.',

        handler: './cli/commands/push.js#default',

        flags: defineCommandFlags(pushFlags),

        examples: [
          'kb commit publish',
        ],
      },

      // commit:open - Show current plan
      {
        path: 'commit plan show',
        category: 'Plan',
        describe: 'Show current commit plan.',
        operationType: 'read' as const,
        longDescription: 'Displays the current commit plan if one exists.',

        handler: './cli/commands/open.js#default',

        flags: defineCommandFlags(jsonOnlyFlags),

        examples: [
          'kb commit plan show',
          'kb commit plan show --json',
        ],
      },

      // commit:reset - Clear current plan
      {
        path: 'commit plan delete',
        category: 'Plan',
        describe: 'Clear current commit plan.',
        operationType: 'mutate' as const,
        longDescription: 'Removes the current commit plan from storage.',

        handler: './cli/commands/reset.js#default',

        flags: defineCommandFlags(jsonOnlyFlags),

        examples: [
          'kb commit plan delete',
        ],
      },
    ],
  },

  capabilities: [],

  // ✅ V3: Manifest-first permissions using composable presets
  permissions: pluginPermissions,

  // REST API routes (inherit permissions from manifest)
  rest: {
    basePath: COMMIT_BASE_PATH,
    routes: [
    // GET /scopes
    {
      method: 'GET',
      path: COMMIT_ROUTES.SCOPES,
      handler: './rest/handlers/scopes-handler.js#default',
      output: {
        zod: '@kb-labs/sdk#SelectDataSchema',
      },
    },
    // GET /status
    {
      method: 'GET',
      path: COMMIT_ROUTES.STATUS,
      handler: './rest/handlers/status-handler.js#default',
      output: {
        zod: '@kb-labs/commit/contracts#StatusResponseSchema',
      },
    },
    // POST /generate
    {
      method: 'POST',
      path: COMMIT_ROUTES.GENERATE,
      handler: './rest/handlers/generate-handler.js#default',
      input: {
        zod: '@kb-labs/commit/contracts#GenerateRequestSchema',
      },
      output: {
        zod: '@kb-labs/commit/contracts#GenerateResponseSchema',
      },
      timeoutMs: 300000, // 5 minutes for LLM analysis
    },
    // GET /plan
    {
      method: 'GET',
      path: COMMIT_ROUTES.PLAN,
      handler: './rest/handlers/plan-handler.js#default',
      output: {
        zod: '@kb-labs/commit/contracts#PlanResponseSchema',
      },
    },
    // POST /apply
    {
      method: 'POST',
      path: COMMIT_ROUTES.APPLY,
      handler: './rest/handlers/apply-handler.js#default',
      input: {
        zod: '@kb-labs/commit/contracts#ApplyRequestSchema',
      },
      output: {
        zod: '@kb-labs/commit/contracts#ApplyResponseSchema',
      },
      timeoutMs: 600000, // 10 min for pre/post hooks
    },
    // POST /push
    {
      method: 'POST',
      path: COMMIT_ROUTES.PUSH,
      handler: './rest/handlers/push-handler.js#default',
      input: {
        zod: '@kb-labs/commit/contracts#PushRequestSchema',
      },
      output: {
        zod: '@kb-labs/commit/contracts#PushResponseSchema',
      },
      timeoutMs: 600000, // 10 min for pre/post push hooks
    },
    // DELETE /plan
    {
      method: 'DELETE',
      path: COMMIT_ROUTES.RESET,
      handler: './rest/handlers/reset-handler.js#default',
      output: {
        zod: '@kb-labs/commit/contracts#ResetResponseSchema',
      },
    },
    // GET /git-status
    {
      method: 'GET',
      path: COMMIT_ROUTES.GIT_STATUS,
      handler: './rest/handlers/git-status-handler.js#default',
      output: {
        zod: '@kb-labs/commit/contracts#GitStatusResponseSchema',
      },
    },
    // GET /files
    {
      method: 'GET',
      path: COMMIT_ROUTES.FILES,
      handler: './rest/handlers/files-handler.js#default',
    },
    // GET /diff
    {
      method: 'GET',
      path: COMMIT_ROUTES.DIFF,
      handler: './rest/handlers/diff-handler.js#default',
      output: {
        zod: '@kb-labs/commit/contracts#FileDiffResponseSchema',
      },
    },
    // POST /summarize
    {
      method: 'POST',
      path: COMMIT_ROUTES.SUMMARIZE,
      handler: './rest/handlers/summarize-handler.js#default',
      input: {
        zod: '@kb-labs/commit/contracts#SummarizeRequestSchema',
      },
      output: {
        zod: '@kb-labs/commit/contracts#SummarizeResponseSchema',
      },
    },
    // GET /actions
    {
      method: 'GET',
      path: COMMIT_ROUTES.ACTIONS,
      handler: './rest/handlers/actions-handler.js#default',
      output: {
        zod: '@kb-labs/commit/contracts#ActionsResponseSchema',
      },
    },
    // PATCH /plan — edit a single commit in the plan
    {
      method: 'PATCH',
      path: COMMIT_ROUTES.PATCH_PLAN,
      handler: './rest/handlers/patch-plan-handler.js#default',
      input: {
        zod: '@kb-labs/commit/contracts#PatchPlanRequestSchema',
      },
      output: {
        zod: '@kb-labs/commit/contracts#PatchPlanResponseSchema',
      },
    },
    // POST /regenerate-commit — regenerate a single commit with LLM
    {
      method: 'POST',
      path: COMMIT_ROUTES.REGENERATE_COMMIT,
      handler: './rest/handlers/regenerate-handler.js#default',
      input: {
        zod: '@kb-labs/commit/contracts#RegenerateCommitRequestSchema',
      },
      output: {
        zod: '@kb-labs/commit/contracts#RegenerateCommitResponseSchema',
      },
      timeoutMs: 300000, // 5 minutes for LLM analysis
    },
    ],
  },

  // Studio V2 — Module Federation pages
  studio: {
    version: 2 as const,
    remoteName: 'commitPlugin',
    pages: [
      {
        id: 'commit.overview',
        title: 'Commit',
        icon: 'GitlabOutlined',
        route: '/p/commit',
        entry: './CommitOverview',
        order: 1,
      },
    ],
    menus: [
      {
        id: 'commit',
        label: 'Commit',
        icon: 'GitlabOutlined',
        target: 'commit.overview',
        order: 30,
      },
    ],
  },

  // Legacy V1 studio widgets (deleted)
  /*
  _legacy_studio: {
    widgets: [
    // Workspace Selector
    {
      id: 'commit.workspace-selector',
      kind: 'select',
      title: 'Select Scope',
      description: 'Choose monorepo package or repository',
      data: {
        source: {
          type: 'rest',
          routeId: COMMIT_WIDGET_ROUTES.SCOPES,
          method: 'GET',
        },
      },
      options: {
        searchable: true,
        placeholder: 'Select scope...',
      },
      events: {
        emit: [{
          name: COMMIT_EVENTS.SCOPE_CHANGED,
          payloadMap: { scope: 'value' },  // Maps selected value to payload.scope
        }],
      },
      layoutHint: { w: 6, h: 1, minH: 1 },
      order: 0,
    },
    // Status Metrics
    {
      id: 'commit.status',
      kind: 'metric-group',
      title: 'Commit Status',
      description: 'Current plan and git status',
      data: {
        source: {
          type: 'rest',
          routeId: COMMIT_WIDGET_ROUTES.STATUS,
          method: 'GET',
        },
      },
      events: {
        subscribe: [
          {
            name: COMMIT_EVENTS.SCOPE_CHANGED,
            paramsMap: { scope: 'scope' },  // Maps payload.workspace to params.workspace
          },
          COMMIT_EVENTS.FORM_SUBMITTED,
        ],
      },
      layoutHint: { w: 6, h: 2, minH: 2 },
      order: 1,
    },
    // Plan Viewer (child of commit.plan-section)
    {
      id: 'commit.plan-viewer',
      kind: 'cardlist',
      title: '',  // Title shown in parent section
      description: '',
      data: {
        source: {
          type: 'rest',
          routeId: COMMIT_WIDGET_ROUTES.PLAN,
          method: 'GET',
        },
      },
      options: {
        layout: 'list',
        emptyMessage: 'No plan. Click Generate Plan to create commits.',
      },
      events: {
        subscribe: [
          {
            name: COMMIT_EVENTS.SCOPE_CHANGED,
            paramsMap: { scope: 'scope' },
          },
          {
            name: COMMIT_EVENTS.PLAN_GENERATED,
            // When plan is generated, update widget data with cards
            // No paramsMap - use entire payload as widget data
          },
          COMMIT_EVENTS.FORM_SUBMITTED,
        ],
      },
      order: 2,
    },
    // Git Files Table (child of commit.files-section)
    {
      id: 'commit.git-files',
      kind: 'table',
      title: '',  // Title shown in parent section
      description: '',
      data: {
        source: {
          type: 'rest',
          routeId: COMMIT_WIDGET_ROUTES.FILES,
          method: 'GET',
        },
      },
      options: {
        columns: [
          {
            id: 'path',
            label: 'File',
            sortable: true,
            width: '60%',
          },
          {
            id: 'status',
            label: 'Status',
            sortable: true,
            width: 80,
          },
          {
            id: 'changes',
            label: 'Changes',
            sortable: false,
            width: 120,
          },
        ],
        pagination: false,
        rowSelection: false,
        size: 'small',
      },
      events: {
        subscribe: [{
          name: COMMIT_EVENTS.SCOPE_CHANGED,
          paramsMap: { scope: 'scope' },
        }],
      },
      order: 3,
    },
    // Quick Actions Widget
    {
      id: 'commit.actions',
      kind: 'card',
      title: 'Quick Actions',
      description: 'Common commit workflow actions',
      data: {
        source: {
          type: 'rest',
          routeId: COMMIT_WIDGET_ROUTES.ACTIONS,
          method: 'GET',
        },
      },
      events: {
        subscribe: [{
          name: COMMIT_EVENTS.SCOPE_CHANGED,
          paramsMap: { scope: 'scope' },
        }],
      },
      actions: [
        {
          id: 'generate',
          label: 'Generate Plan',
          icon: 'ThunderboltOutlined',
          variant: 'primary',
          handler: {
            type: 'rest',
            routeId: COMMIT_WIDGET_ROUTES.GENERATE,
            method: 'POST',
            bodyMap: { scope: 'scope' },
            onSuccess: {
              emitEvent: COMMIT_EVENTS.PLAN_GENERATED,
              // Response data will be used as payload (contains plan + workspace)
            },
          },
        },
        {
          id: 'apply',
          label: 'Apply Commits',
          icon: 'CheckOutlined',
          variant: 'default',
          handler: {
            type: 'rest',
            routeId: COMMIT_WIDGET_ROUTES.APPLY,
            method: 'POST',
            bodyMap: { scope: 'scope' },
          },
          confirm: {
            title: 'Apply Commits',
            description: 'This will create git commits according to the plan. Continue?',
            confirmLabel: 'Apply',
            cancelLabel: 'Cancel',
          },
        },
        {
          id: 'push',
          label: 'Push',
          icon: 'UploadOutlined',
          handler: {
            type: 'rest',
            routeId: COMMIT_WIDGET_ROUTES.PUSH,
            method: 'POST',
            bodyMap: { scope: 'scope' },
          },
          confirm: {
            title: 'Push to Remote',
            description: 'This will push commits to the remote repository. Continue?',
            confirmLabel: 'Push',
            cancelLabel: 'Cancel',
          },
        },
      ],
      layoutHint: { w: 6, h: 3, minH: 2 },
      order: 6,
    },
    // Files Section (collapsible, GitLab-style)
    {
      id: 'commit.files-section',
      kind: 'section',
      title: 'Changed Files',
      description: 'Files with uncommitted changes',
      data: {
        source: { type: 'static' },  // Sections use static source (no data)
      },
      options: {
        collapsible: true,
        defaultExpanded: true,
        variant: 'bordered',
        icon: 'FolderOutlined',
        showDivider: true,
      },
      children: ['commit.git-files'],
      events: {
        subscribe: [{
          name: COMMIT_EVENTS.SCOPE_CHANGED,
          paramsMap: { scope: 'scope' },
        }],
      },
      layoutHint: { w: 6, h: 8, minH: 4 },
      order: 4,
    },
    // Plan Section (collapsible, GitLab-style)
    {
      id: 'commit.plan-section',
      kind: 'section',
      title: 'Commit Plan',
      description: 'Generated commits ready to apply',
      data: {
        source: { type: 'static' },  // Sections use static source (no data)
      },
      options: {
        collapsible: true,
        defaultExpanded: true,
        variant: 'bordered',
        icon: 'FileTextOutlined',
        showDivider: true,
      },
      children: ['commit.plan-viewer'],
      events: {
        subscribe: [
          {
            name: COMMIT_EVENTS.SCOPE_CHANGED,
            paramsMap: { scope: 'scope' },
          },
          COMMIT_EVENTS.FORM_SUBMITTED,
        ],
      },
      layoutHint: { w: 6, h: 8, minH: 4 },
      order: 5,
    },
    ],
    // Studio menus
    menus: [
      {
        id: 'commit-menu',
        label: 'Commit',
        icon: 'GitlabOutlined',
        target: '/plugins/commit/overview',
        order: 0,
      },
      {
        id: 'commit-overview',
        label: 'Overview',
        icon: 'DashboardOutlined',
        parentId: 'commit-menu',
        target: '/plugins/commit/overview',
        order: 1,
      },
      {
        id: 'commit-plan',
        label: 'Plan',
        icon: 'UnorderedListOutlined',
        parentId: 'commit-menu',
        target: '/plugins/commit/plan',
        order: 2,
      },
      {
        id: 'commit-files',
        label: 'Files',
        icon: 'FileTextOutlined',
        parentId: 'commit-menu',
        target: '/plugins/commit/files',
        order: 3,
      },
    ],
    // Studio layouts
    layouts: [
      // Overview page - Quick status and actions
      {
        id: 'commit.overview',
        kind: 'grid',
        title: 'Overview',
        description: 'Workspace status and quick actions',
        icon: 'home',
        widgets: [
          'commit.workspace-selector',
          'commit.status',
          'commit.actions',
          'commit.plan-section',  // Show plan section on overview too
        ],
        config: {
          cols: 6,
          gap: 16,
        },
        order: 1,
      },
      // Plan page - GitLab-style commit plan view
      {
        id: 'commit.plan',
        kind: 'grid',
        title: 'Commit Plan',
        description: 'Review and manage generated commits',
        icon: 'list',
        widgets: [
          'commit.workspace-selector',
          'commit.files-section',
          'commit.plan-section',
        ],
        actions: [
          {
            id: 'generate',
            label: 'Generate Plan',
            icon: 'ThunderboltOutlined',
            variant: 'primary',
            handler: {
              type: 'rest',
              routeId: COMMIT_WIDGET_ROUTES.GENERATE,
              method: 'POST',
            },
          },
          {
            id: 'apply',
            label: 'Apply Commits',
            icon: 'CheckOutlined',
            variant: 'default',
            handler: {
              type: 'rest',
              routeId: COMMIT_WIDGET_ROUTES.APPLY,
              method: 'POST',
            },
            confirm: {
              title: 'Apply Commits',
              description: 'This will create git commits according to the plan. Continue?',
              confirmLabel: 'Apply',
              cancelLabel: 'Cancel',
            },
          },
          {
            id: 'push',
            label: 'Push',
            icon: 'UploadOutlined',
            handler: {
              type: 'rest',
              routeId: COMMIT_WIDGET_ROUTES.PUSH,
              method: 'POST',
            },
            confirm: {
              title: 'Push to Remote',
              description: 'This will push commits to the remote repository. Continue?',
              confirmLabel: 'Push',
              cancelLabel: 'Cancel',
            },
          },
          {
            id: 'reset',
            label: 'Reset Plan',
            icon: 'DeleteOutlined',
            variant: 'danger',
            handler: {
              type: 'rest',
              routeId: COMMIT_WIDGET_ROUTES.RESET,
              method: 'DELETE',
            },
            confirm: {
              title: 'Reset Plan',
              description: 'This will delete the current commit plan. This action cannot be undone.',
              confirmLabel: 'Delete',
              cancelLabel: 'Cancel',
            },
          },
        ],
        config: {
          cols: 6,
          gap: 16,
        },
        order: 2,
      },
      // Files page - Changed files table
      {
        id: 'commit.files',
        kind: 'grid',
        title: 'Changed Files',
        description: 'Git status and modified files',
        icon: 'file',
        widgets: [
          'commit.workspace-selector',
          'commit.git-files',
        ],
        config: {
          cols: 6,
          gap: 16,
        },
        order: 3,
      },
    ],
  },
  */

  // Artifacts
  artifacts: [
    {
      id: 'commit.plan.json',
      pathTemplate: '.kb/commit/current/plan.json',
      description: 'Current commit plan.',
    },
    {
      id: 'commit.status.json',
      pathTemplate: '.kb/commit/current/status.json',
      description: 'Git status snapshot at plan generation time.',
    },
  ],
};
