/**
 * Declarative flag definitions for commit plugin commands
 *
 * Using the new defineFlags system from @kb-labs/sdk for:
 * - Type safety
 * - Runtime validation
 * - Automatic type inference
 * - Consistent DX across commands
 */

import { defineFlags } from "@kb-labs/sdk";

/**
 * Flags for commit:commit (run) command
 *
 * @example
 * ```bash
 * kb commit commit --scope="@kb-labs/core" --dry-run --with-push
 * ```
 */
export const commitFlags = defineFlags({
  scope: {
    type: "string",
    description: "Limit commits to specific package or path pattern",
    examples: ["@kb-labs/core", "packages/**", "kb-labs-mind/**"],
  },
  json: {
    type: "boolean",
    description: "Output result as JSON instead of formatted text",
    default: false,
  },
  "dry-run": {
    type: "boolean",
    description: "Preview commits without applying them to git",
    default: false,
  },
  "with-push": {
    type: "boolean",
    description: "Push commits to remote after applying",
    default: false,
  },
  "allow-secrets": {
    type: "boolean",
    description:
      "Allow committing files with detected secrets (requires manual confirmation). Use with caution after reviewing detected locations.",
    default: false,
  },
  yes: {
    type: "boolean",
    description: "Automatically confirm all prompts (non-interactive mode)",
    default: false,
  },
});

/**
 * Inferred TypeScript type for commit command input
 *
 * Type resolves to:
 * {
 *   scope?: string;
 *   json: boolean;
 *   'dry-run': boolean;
 *   'with-push': boolean;
 * }
 */
export type CommitFlags = typeof commitFlags.infer;

/**
 * Flags for commit:generate command
 *
 * @example
 * ```bash
 * kb commit plan create --scope="@kb-labs/cli" --json
 * ```
 */
export const generateFlags = defineFlags({
  scope: {
    type: "string",
    description: "Limit analysis to specific package or path pattern",
    examples: ["@kb-labs/core", "packages/**", "kb-labs-mind/**"],
  },
  json: {
    type: "boolean",
    description: "Output commit plan as JSON instead of formatted text",
    default: false,
  },
  "allow-secrets": {
    type: "boolean",
    description:
      "Allow generating commits for files with detected secrets (requires manual confirmation). Use with caution after reviewing detected locations.",
    default: false,
  },
  yes: {
    type: "boolean",
    description: "Automatically confirm all prompts (non-interactive mode)",
    default: false,
  },
});

/**
 * Inferred TypeScript type for generate command input
 *
 * Type resolves to:
 * {
 *   scope?: string;
 *   json: boolean;
 * }
 */
export type GenerateFlags = typeof generateFlags.infer;
