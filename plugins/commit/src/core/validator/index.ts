/**
 * Commit plan validation — shared by applier, REST handlers, CLI, and MCP.
 *
 * Centralizes checks that used to live only inside apply.ts, so that any
 * surface (Studio, CLI, MCP) can proactively report plan integrity/staleness
 * before the user attempts to apply, instead of only failing at apply time.
 *
 * @module @kb-labs/commit/core/validator
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommitPlan } from "../../contracts/index.js";
import { useLogger } from "@kb-labs/sdk";
import { getGitStatus, getAllChangedFiles } from "../analyzer/git-status";

/**
 * Group files by their git repository (root or nested)
 *
 * Supports nested git repositories: files with a first path segment that is
 * itself a git repo root are grouped under that nested repo instead of cwd.
 */
export function groupFilesByRepo(
  cwd: string,
  files: string[],
): Map<string, { relativePath: string; originalPath: string }[]> {
  const filesByRepo = new Map<
    string,
    { relativePath: string; originalPath: string }[]
  >();

  for (const file of files) {
    // Check if file is in a nested repo (first segment might be a git repo)
    const segments = file.split("/");
    const potentialRepoDir = segments[0];

    // Handle edge case: empty file path or no segments
    if (!potentialRepoDir) {
      const group = filesByRepo.get(cwd) ?? [];
      group.push({ relativePath: file, originalPath: file });
      filesByRepo.set(cwd, group);
      continue;
    }

    const potentialRepoPath = join(cwd, potentialRepoDir);
    const potentialGitDir = join(potentialRepoPath, ".git");

    // Check if it's actually a nested git repo
    const isNestedRepo = existsSync(potentialGitDir);

    if (isNestedRepo) {
      // Use nested repo as git root, strip first segment from path
      const relativePath = segments.slice(1).join("/");
      const group = filesByRepo.get(potentialRepoPath) ?? [];
      group.push({ relativePath, originalPath: file });
      filesByRepo.set(potentialRepoPath, group);
    } else {
      // Use cwd as git root
      const group = filesByRepo.get(cwd) ?? [];
      group.push({ relativePath: file, originalPath: file });
      filesByRepo.set(cwd, group);
    }
  }

  return filesByRepo;
}

/**
 * Validate internal consistency of a commit plan: every commit has files and
 * a message, and no file appears in more than one commit.
 *
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validatePlanIntegrity(plan: CommitPlan): string[] {
  const errors: string[] = [];
  const seenInCommit = new Map<string, string>();

  for (const commit of plan.commits) {
    if (commit.files.length === 0) {
      errors.push(`Commit ${commit.id} has no files`);
      continue;
    }

    if (!commit.message.trim()) {
      errors.push(`Commit ${commit.id} has empty message`);
      continue;
    }

    for (const file of commit.files) {
      const firstCommit = seenInCommit.get(file);
      if (firstCommit) {
        errors.push(
          `File appears in multiple commits: ${file} (first: ${firstCommit}, duplicate: ${commit.id})`,
        );
      } else {
        seenInCommit.set(file, commit.id);
      }
    }
  }

  return errors;
}

/**
 * Check if files in the plan have changed since plan generation.
 *
 * Only checks files that are part of the plan, ignoring other changes in the
 * repo — cheap even on a large repo. Used both proactively (status handlers,
 * before the user attempts Apply) and as the last-second guard inside
 * applyCommitPlan.
 */
export async function checkPlanStaleness(
  cwd: string,
  plan: CommitPlan,
  scope?: string,
): Promise<{ isStale: boolean; reason: string }> {
  const logger = useLogger();
  const planFiles = new Set(plan.commits.flatMap((c) => c.files));

  await logger.debug("checkPlanStaleness: start", {
    scope,
    cwd,
    planFiles: [...planFiles],
  });

  // If no files in plan, nothing to check
  if (planFiles.size === 0) {
    return { isStale: false, reason: "" };
  }

  // Determine which repo(s) we need to check
  const filesByRepo = groupFilesByRepo(cwd, [...planFiles]);

  // Check each repo for staleness
  for (const [repoPath, fileInfos] of filesByRepo) {
    // Get current git status from the repo
    // Note: repoPath already points to the correct git repository root
    const currentStatus = await getGitStatus(repoPath);
    const currentFiles = new Set(getAllChangedFiles(currentStatus));

    await logger.debug("checkPlanStaleness: repo status", {
      repoPath,
      staged: currentStatus.staged,
      unstaged: currentStatus.unstaged,
      untracked: currentStatus.untracked,
      expected: fileInfos.map((f) => f.relativePath),
    });

    // Check that all expected files are still changed
    for (const { relativePath, originalPath } of fileInfos) {
      if (!currentFiles.has(relativePath)) {
        await logger.warn("checkPlanStaleness: file not in current changes", {
          scope,
          repoPath,
          originalPath,
          relativePath,
          currentFiles: [...currentFiles],
        });
        return {
          isStale: true,
          reason: `File no longer has changes: ${originalPath}. Regenerate plan or use --force.`,
        };
      }
    }
  }

  return { isStale: false, reason: "" };
}
