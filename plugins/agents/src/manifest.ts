/**
 * KB Labs Agent Plugin - Manifest V3
 */

import {
  combinePermissions,
  kbPlatformPreset,
  defineCommandFlags,
} from '@kb-labs/sdk';
import {
  AGENTS_BASE_PATH,
  AGENTS_WS_BASE_PATH,
  AGENTS_ROUTES,
  AGENTS_WS_CHANNELS,
} from './contracts/index.js';

/**
 * Command flags for agent:run (unified command with modes)
 */
const runFlags = {
  task: {
    type: 'string',
    description: 'Task description',
  },
  mode: {
    type: 'string',
    description: 'Agent mode: execute (default), plan, edit, debug',
    default: 'execute',
  },
  'session-id': {
    type: 'string',
    description: 'Session ID (auto-generated if not provided)',
  },
  complexity: {
    type: 'string',
    description: 'Task complexity (for plan mode): simple, medium, complex',
  },
  approve: {
    type: 'boolean',
    description: 'Auto-approve generated plan (supported with --mode=plan)',
    default: false,
  },
  execute: {
    type: 'boolean',
    description: 'After plan is approved, immediately execute it (use with --mode=plan --approve)',
    default: false,
  },
  files: {
    type: 'array',
    description: 'Target files (for edit mode)',
  },
  trace: {
    type: 'string',
    description: 'Trace file path (for debug mode)',
  },
  'dry-run': {
    type: 'boolean',
    description: 'Preview changes without applying (for edit mode)',
    default: false,
  },
  verbose: {
    type: 'boolean',
    description: 'Verbose output',
    default: false,
  },
  debug: {
    type: 'boolean',
    description: 'Enable debug mode: emit full prompts and responses as llm:debug events',
    default: false,
  },
  timeout: {
    type: 'number',
    description: 'Abort agent execution after this many seconds (exit code 124). No timeout by default.',
  },
  budget: {
    type: 'number',
    description: 'Override token budget (e.g. 300000 for heavy tasks). Overrides config value.',
  },
  json: {
    type: 'boolean',
    description: 'Output structured JSON result instead of human-readable output.',
  },
} as const;

/**
 * Plugin permissions
 */
const pluginPermissions = combinePermissions()
  .with(kbPlatformPreset)
  .withFs({
    mode: 'readWrite',
    allow: ['.agent-memory/**', '**/*'], // Allow filesystem operations in working dir
  })
  .withPlatform({
    llm: true,  // Full LLM access for agent execution
    cache: ['agent:'], // Cache namespace prefix
    analytics: true,  // Track agent usage
  })
  .withQuotas({
    timeoutMs: 1800000, // 30 min for complex tasks
    memoryMb: 1024,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/agents',
  version: '0.1.0',

  display: {
    name: 'Agent System',
    description: 'Autonomous agents, tool calling, and task orchestration',
    tags: ['agent', 'autonomous', 'llm', 'orchestration'],
  },

  // Configuration lives under kb.config.json -> agents
  configSection: 'agents',

  platform: {
    requires: ['llm'],
    optional: ['cache', 'analytics', 'logger'],
  },

  cli: {
    groupMeta: [
      { path: 'agent', describe: 'Autonomous agent commands' },
      { path: 'agent trace', describe: 'Agent trace debugging commands' },
      { path: 'agent quality', describe: 'Agent quality control commands' },
    ],
    commands: [
      {
        path: 'agent run',
        category: 'Run',
        describe: 'Run agent task (execute, plan, edit, or debug)',
        operationType: 'execute' as const,
        longDescription:
          'Unified agent command with multiple modes: ' +
          'execute (default) - run task immediately, ' +
          'plan - generate execution plan without running, ' +
          'edit - modify existing files, ' +
          'debug - analyze errors with trace context. ' +
          'Supports filesystem, search, shell, memory, and user interaction tools.',

        handler: './cli/commands/run.js#default',

        flags: defineCommandFlags(runFlags),

        examples: [
          'kb agent run --task="Create analytics system"',
          'kb agent run --mode=plan --task="Add auth" --complexity=complex',
          'kb agent run --mode=plan --task="Add auth" --approve',
          'kb agent run --mode=plan --task="Add auth" --approve --execute',
          'kb agent run --mode=edit --task="Fix bug" --files src/auth.ts',
          'kb agent run --mode=debug --task="Why crash?" --trace .kb/traces/trace-123.json',
          'kb agent run --task="Refactor auth module" --timeout=120',
        ],
      },
      // Trace debugging commands (AI-friendly)
      {
        path: 'agent trace stats show',
        category: 'Trace',
        describe: 'Show trace statistics: tokens, cost, timing',
        operationType: 'read' as const,
        longDescription:
          'Analyze trace file to show comprehensive statistics: ' +
          'iterations, LLM calls, token usage, tool usage, timing, and cost. ' +
          'Supports --json flag for AI agent consumption.',

        handler: './cli/commands/trace-stats.js#default',

        flags: defineCommandFlags({
          'task-id': { type: 'string', description: 'Task ID or trace filename' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent trace stats show --task-id=task-2026-01-29',
          'kb agent trace stats show --task-id=task-123 --json',
        ],
      },
      {
        path: 'agent trace list',
        category: 'Trace',
        describe: 'Filter trace events by type for debugging',
        operationType: 'read' as const,
        longDescription:
          'Filter trace events by type (llm:call, tool:execution, error:captured, etc.). ' +
          'Use this to debug specific aspects of agent execution. ' +
          'Supports --json flag for programmatic access.',

        handler: './cli/commands/trace-filter.js#default',

        flags: defineCommandFlags({
          'task-id': { type: 'string', description: 'Task ID or trace filename' },
          type: { type: 'string', description: 'Event type to filter (llm:call, tool:execution, etc.)' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent trace list --task-id=task-123 --type=llm:call',
          'kb agent trace list --task-id=task-123 --type=error:captured --json',
        ],
      },
      {
        path: 'agent trace iteration show',
        category: 'Trace',
        describe: 'View all events for a specific iteration',
        operationType: 'read' as const,
        longDescription:
          'Show all trace events for a specific iteration number. ' +
          'Useful for debugging what happened in a particular loop iteration. ' +
          'Includes summary statistics and event timeline.',

        handler: './cli/commands/trace-iteration.js#default',

        flags: defineCommandFlags({
          'task-id': { type: 'string', description: 'Task ID or trace filename' },
          iteration: { type: 'number', description: 'Iteration number (1-based)' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent trace iteration show --task-id=task-123 --iteration=3',
          'kb agent trace iteration show --task-id=task-123 --iteration=5 --json',
        ],
      },
      {
        path: 'agent trace context show',
        category: 'Trace',
        describe: 'Inspect context window and truncations per iteration',
        operationType: 'read' as const,
        longDescription:
          'Shows the full context timeline for debugging agent behavior. ' +
          'For each LLM call: what messages are in the sliding window, ' +
          'what was truncated/dropped, and what the LLM responded with.',

        handler: './cli/commands/trace-context.js#default',

        flags: defineCommandFlags({
          'task-id': { type: 'string', description: 'Task ID or trace filename' },
          iteration: { type: 'number', description: 'Filter to specific iteration' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent trace context show --task-id=task-123',
          'kb agent trace context show --task-id=task-123 --iteration=3',
          'kb agent trace context show --task-id=task-123 --json',
        ],
      },
      {
        path: 'agent trace doctor',
        category: 'Trace',
        describe: 'Diagnose what went wrong in an agent run',
        operationType: 'analyze' as const,
        longDescription:
          'Comprehensive diagnostic report for agent execution. ' +
          'Analyzes errors, context window health (drops, truncations), ' +
          'tool failures, LLM reasoning text, loop detection, and quality indicators. ' +
          'One command to understand any agent issue.',

        handler: './cli/commands/trace-diagnose.js#default',

        flags: defineCommandFlags({
          'task-id': { type: 'string', description: 'Task ID or trace filename' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent trace doctor --task-id=task-123',
          'kb agent trace doctor --task-id=task-123 --json',
        ],
      },
      {
        path: 'agent quality report show',
        category: 'Quality',
        describe: 'Show quality control report for recent agent runs',
        operationType: 'analyze' as const,
        longDescription:
          'Aggregates agent KPI telemetry from analytics buffer and shows ' +
          'quality, token usage, tool efficiency, drift, and regression alerts. ' +
          'Useful for continuous quality control and cost/performance monitoring.',

        handler: './cli/commands/quality-report.js#default',

        flags: defineCommandFlags({
          days: { type: 'number', description: 'Lookback period in days', default: 1 },
          limit: { type: 'number', description: 'Max KPI runs to analyze', default: 200 },
          'session-id': { type: 'string', description: 'Filter by session ID' },
          json: { type: 'boolean', description: 'Output JSON for automation', default: false },
        }),

        examples: [
          'kb agent quality report show',
          'kb agent quality report show --days=7',
          'kb agent quality report show --session-id=session-123',
          'kb agent quality report show --days=3 --json',
        ],
      },
      // File change history commands
      {
        path: 'agent history list',
        category: 'History',
        describe: 'Show file change history for agent sessions',
        operationType: 'read' as const,
        longDescription:
          'View file changes made by agents during execution. ' +
          'Filter by session, file, or agent. Shows timestamps, operations, and change metadata.',

        handler: './cli/commands/history.js#default',

        flags: defineCommandFlags({
          'session-id': { type: 'string', description: 'Session ID to filter by' },
          file: { type: 'string', description: 'File path to filter by' },
          'agent-id': { type: 'string', description: 'Agent ID to filter by' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent history list',
          'kb agent history list --session-id=session-123',
          'kb agent history list --file=src/index.ts',
          'kb agent history list --agent-id=agent-abc --json',
        ],
      },
      {
        path: 'agent diff',
        category: 'History',
        describe: 'Show diff for specific file change',
        operationType: 'read' as const,
        longDescription:
          'Display line-by-line diff for a specific file change. ' +
          'Shows additions, deletions, and modifications with context.',

        handler: './cli/commands/diff.js#default',

        flags: defineCommandFlags({
          'change-id': { type: 'string', description: 'Change ID to show diff for' },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent diff --change-id=change-abc123',
          'kb agent diff --change-id=change-abc123 --json',
        ],
      },
      {
        path: 'agent rollback',
        category: 'History',
        describe: 'Rollback file changes made by agents',
        operationType: 'mutate' as const,
        longDescription:
          'Rollback file changes made by agents. ' +
          'Supports rollback by change ID, file path, agent ID, session, or timestamp. ' +
          'Use --dry-run to preview changes before applying.',

        handler: './cli/commands/rollback.js#default',

        flags: defineCommandFlags({
          'change-id': { type: 'string', description: 'Change ID to rollback' },
          file: { type: 'string', description: 'File path to rollback all changes for' },
          'agent-id': { type: 'string', description: 'Agent ID to rollback all changes by' },
          'session-id': { type: 'string', description: 'Session ID to rollback all changes in' },
          after: { type: 'string', description: 'Rollback all changes after timestamp (ISO 8601)' },
          force: { type: 'boolean', description: 'Force rollback even with conflicts', default: false },
          'dry-run': { type: 'boolean', description: 'Preview rollback without applying', default: false },
          json: { type: 'boolean', description: 'Output JSON for AI agents', default: false },
        }),

        examples: [
          'kb agent rollback --change-id=change-abc123',
          'kb agent rollback --file=src/index.ts --dry-run',
          'kb agent rollback --agent-id=agent-abc',
          'kb agent rollback --session-id=session-123',
          'kb agent rollback --after="2026-02-16T10:00:00Z" --json',
        ],
      },
    ],
  },

  capabilities: [],

  permissions: pluginPermissions,

  // REST API for Agent UI
  rest: {
    basePath: AGENTS_BASE_PATH,
    defaults: {
      timeoutMs: 1800000, // 30 min for long-running tasks
    },
    routes: [
      {
        method: 'POST',
        path: AGENTS_ROUTES.RUN,
        description: 'Start a new agent run',
        handler: './rest/handlers/run-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.RUN_STATUS,
        description: 'Get status of a run',
        handler: './rest/handlers/status-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.CORRECT,
        description: 'Send correction to running agent(s)',
        handler: './rest/handlers/correct-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.STOP,
        description: 'Stop a running agent',
        handler: './rest/handlers/stop-handler.js',
        security: ['none'],
      },
      // Session management routes
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSIONS_LIST,
        description: 'List all sessions',
        handler: './rest/handlers/list-sessions-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_GET,
        description: 'Get session details',
        handler: './rest/handlers/get-session-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_CREATE,
        description: 'Create a new session',
        handler: './rest/handlers/sessions-handler.js#createSessionHandler',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_TURNS,
        description: 'Get session turns (turn-based UI)',
        handler: './rest/handlers/get-session-turns-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_PLAN_GET,
        description: 'Get current session plan',
        handler: './rest/handlers/get-session-plan-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_PLAN_APPROVE,
        description: 'Approve current session plan',
        handler: './rest/handlers/approve-session-plan-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_PLAN_EXECUTE,
        description: 'Execute approved session plan',
        handler: './rest/handlers/execute-session-plan-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_PLAN_SPEC,
        description: 'Generate detailed spec from approved plan',
        handler: './rest/handlers/generate-spec-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_PLAN_SPEC_GET,
        description: 'Get current session spec',
        handler: './rest/handlers/get-spec-handler.js',
        security: ['none'],
      },
      // File change history routes (rollback & approve)
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_CHANGES,
        description: 'List file changes for session (optionally filtered by runId)',
        handler: './rest/handlers/list-file-changes-handler.js',
        security: ['none'],
      },
      {
        method: 'GET',
        path: AGENTS_ROUTES.SESSION_CHANGE_DIFF,
        description: 'Get unified diff for a specific file change',
        handler: './rest/handlers/get-file-diff-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_ROLLBACK,
        description: 'Rollback file changes for a session/run',
        handler: './rest/handlers/rollback-handler.js',
        security: ['none'],
      },
      {
        method: 'POST',
        path: AGENTS_ROUTES.SESSION_APPROVE,
        description: 'Approve file changes for a session/run',
        handler: './rest/handlers/approve-handler.js',
        security: ['none'],
      },
    ],
  },

  // WebSocket for real-time event streaming
  ws: {
    basePath: AGENTS_WS_BASE_PATH,
    defaults: {
      auth: 'none',
      idleTimeoutMs: 3600000, // 1 hour
    },
    channels: [
      {
        path: AGENTS_WS_CHANNELS.SESSION_STREAM,
        description: 'Persistent session stream (all runs in session)',
        handler: './ws/session-stream-handler.js',
        auth: 'none',
      },
    ],
  },

  artifacts: [
    {
      id: 'agent.memory.json',
      pathTemplate: '.agent-memory/memory.json',
      description: 'Persistent agent memory (facts, sessions, project context).',
    },
  ],

  studio: {
    version: 2 as const,
    remoteName: 'agentPlugin',
    pages: [
      {
        id: 'agent.overview',
        title: 'Agent',
        icon: 'RobotOutlined',
        route: '/p/agent',
        entry: './AgentsPage',
        order: 1,
      },
    ],
    menus: [
      {
        id: 'agent',
        label: 'Agent',
        icon: 'RobotOutlined',
        target: 'agent.overview',
        order: 30,
      },
    ],
  },
};
