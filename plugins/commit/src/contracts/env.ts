/**
 * Environment variable definitions for commit plugin
 */

import { defineEnv } from "@kb-labs/sdk";

export const commitEnv = defineEnv({
  KB_COMMIT_LLM_ENABLED: {
    type: "boolean",
    default: true,
    description: "Enable LLM-powered commit analysis",
  },
  KB_COMMIT_LLM_TEMPERATURE: {
    type: "number",
    default: 0.3,
    description: "LLM temperature for commit message generation (0-1)",
    validate: (v) => {
      if (v < 0 || v > 1) {
        throw new Error("KB_COMMIT_LLM_TEMPERATURE must be between 0 and 1");
      }
    },
  },
  KB_COMMIT_LLM_MAX_TOKENS: {
    type: "number",
    default: 2000,
    description: "Maximum tokens for LLM commit analysis",
  },
  KB_COMMIT_STORAGE_DIR: {
    type: "string",
    default: ".kb/commit",
    description: "Directory for storing commit history",
  },
  KB_COMMIT_AUTO_STAGE: {
    type: "boolean",
    default: false,
    description: "Automatically stage files before committing",
  },
});

export type CommitEnv = typeof commitEnv.type;
