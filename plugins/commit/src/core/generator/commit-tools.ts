/**
 * Tool definitions for native LLM tool calling
 * Replaces text-based JSON parsing with structured OpenAI Function Calling
 */

import type { LLMTool } from '@kb-labs/sdk';

/**
 * Tool: generate_commit_plan_phase3
 *
 * Used by Phase 3 to either extend existing commits or create new commits for missing files
 * Supports two actions: extend_existing (add files to existing commit) and create_new (create new commit)
 */
export const COMMIT_PLAN_TOOL_PHASE3: LLMTool = {
  name: 'generate_commit_plan',
  description: 'Generate commits for missing files - either extend existing commits or create new ones',
  inputSchema: {
    type: 'object',
    properties: {
      commits: {
        type: 'array',
        description: 'List of commit actions. Can mix extend_existing and create_new actions.',
        items: {
          type: 'object',
          required: ['action', 'files'],
          properties: {
            action: {
              type: 'string',
              enum: ['create_new', 'extend_existing'],
              description: 'Whether to create a new commit or add files to an existing commit. Use "extend_existing" to avoid creating unnecessary commits.',
            },
            existingCommitId: {
              type: 'string',
              description: 'ID of existing commit to extend (REQUIRED when action is "extend_existing"). Example: "c1", "c2".',
              pattern: '^c[0-9]+$',
            },
            id: {
              type: 'string',
              description: 'Unique commit identifier (REQUIRED for create_new action, e.g., c1, c2, c3).',
              pattern: '^c[0-9]+$',
            },
            type: {
              type: 'string',
              enum: ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'build', 'ci', 'perf'],
              description: 'Conventional commit type (REQUIRED for create_new action).',
            },
            scope: {
              type: 'string',
              description: 'Scope of the commit (optional).',
            },
            message: {
              type: 'string',
              description: 'Commit message in imperative mood (REQUIRED for create_new action).',
              minLength: 5,
              maxLength: 100,
            },
            body: {
              type: 'string',
              description: 'Detailed description (optional).',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of file paths to add to this commit.',
              minItems: 1,
            },
            releaseHint: {
              type: 'string',
              enum: ['none', 'patch', 'minor', 'major'],
              description: 'Semantic versioning impact (REQUIRED for create_new action).',
            },
            breaking: {
              type: 'boolean',
              description: 'Whether this is a breaking change.',
              default: false,
            },
            reasoning: {
              type: 'object',
              description: 'Reasoning for classification (REQUIRED for create_new action).',
              properties: {
                newBehavior: { type: 'boolean' },
                fixesBug: { type: 'boolean' },
                internalOnly: { type: 'boolean' },
                explanation: { type: 'string', minLength: 10, maxLength: 300 },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      },
    },
    required: ['commits'],
  },
};

/**
 * Tool: generate_commit_plan
 *
 * Used by Phase 1 and Phase 2 to structure commit plan output using OpenAI Function Calling API
 * This guarantees valid JSON output without parsing errors
 */
export const COMMIT_PLAN_TOOL: LLMTool = {
  name: 'generate_commit_plan',
  description: 'Generate a structured commit plan with conventional commits following best practices',
  inputSchema: {
    type: 'object',
    properties: {
      needsMoreContext: {
        type: 'boolean',
        description: 'Whether you need to see diff content to make accurate commit type decisions. Set to true if file paths and stats alone are insufficient.',
        default: false,
      },
      requestedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of SPECIFIC files you need diffs for (MAXIMUM 15 files). Only request files where file path and stats are insufficient. DO NOT request all files - be selective and choose only the most critical/ambiguous ones. Prioritize files with unclear intent or complex changes.',
        default: [],
      },
      commits: {
        type: 'array',
        description: 'List of commit groups. Each commit groups related files by logical change (not by file type or directory).',
        items: {
          type: 'object',
          required: ['id', 'type', 'message', 'files', 'releaseHint', 'breaking', 'reasoning'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique commit identifier (e.g., c1, c2, c3).',
              pattern: '^c[0-9]+$',
            },
            type: {
              type: 'string',
              enum: ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'build', 'ci', 'perf'],
              description: 'Conventional commit type. Use refactor for internal changes, feat only for new user-facing features.',
            },
            scope: {
              type: 'string',
              description: 'Scope of the commit (e.g., "cli", "api", "core"). Should reflect affected area, not individual files.',
            },
            message: {
              type: 'string',
              description: 'Commit message in imperative mood, lowercase, no period at end (e.g., "add authentication middleware")',
              minLength: 5,
              maxLength: 100,
            },
            body: {
              type: 'string',
              description: 'Detailed description with bullet points listing affected files/changes. Use for commits with 2+ files.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of file paths in this commit. Each file must appear in exactly ONE commit (no duplicates across commits).',
              minItems: 1,
            },
            releaseHint: {
              type: 'string',
              enum: ['none', 'patch', 'minor', 'major'],
              description: 'Semantic versioning impact. Use "minor" for feat, "patch" for fix/refactor, "none" for chore/docs/test.',
            },
            breaking: {
              type: 'boolean',
              description: 'Whether this is a breaking change (breaks public API compatibility).',
              default: false,
            },
            reasoning: {
              type: 'object',
              required: ['newBehavior', 'fixesBug', 'internalOnly', 'explanation', 'confidence'],
              description: 'Reasoning for commit type classification. Used for validation and debugging.',
              properties: {
                newBehavior: {
                  type: 'boolean',
                  description: 'Does this change add NEW USER-VISIBLE BEHAVIOR? (new API, feature, capability that users can access)',
                },
                fixesBug: {
                  type: 'boolean',
                  description: 'Does this change fix BROKEN functionality? (corrects bug or error)',
                },
                internalOnly: {
                  type: 'boolean',
                  description: 'Is this ONLY INTERNAL restructuring? (code reorganization, renaming, extracting functions without changing behavior)',
                },
                explanation: {
                  type: 'string',
                  description: 'Explain your classification decision. Why did you choose this commit type?',
                  minLength: 10,
                  maxLength: 300,
                },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Confidence in this classification (0.0 to 1.0). Use <0.7 if you need more context (will trigger Phase 2).',
                },
              },
            },
          },
        },
      },
    },
    required: ['commits'],
  },
};
