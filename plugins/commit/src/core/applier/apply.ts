/**
 * Commit plan applier
 */

/* eslint-disable no-await-in-loop -- Sequential git commits required: must stage files and commit one group at a time */

import { simpleGit, type SimpleGit } from "simple-git";
import type {
  CommitPlan,
  ApplyResult,
  CommitGroup,
} from "../../contracts/index.js";
import type { ApplyOptions } from "../types";
import { validatePlanIntegrity, checkPlanStaleness, groupFilesByRepo } from "../validator";
import { useLogger } from "@kb-labs/sdk";

const GIT_HOOK_NAMES = [
  "pre-commit",
  "commit-msg",
  "post-commit",
  "prepare-commit-msg",
  "pre-push",
] as const;

function cleanGitError(message: string): string {
  return message
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("hint:"))
    .join("\n")
    .trim();
}

function formatCommitError(message: string): string {
  const cleaned = cleanGitError(message);
  const isHookError =
    /hook\s+(failed|exited|returned)/i.test(cleaned) ||
    /husky/i.test(cleaned) ||
    /lint-staged/i.test(cleaned) ||
    GIT_HOOK_NAMES.some((h) => cleaned.includes(h));

  if (isHookError) {
    const match = cleaned.match(
      /(pre-commit|commit-msg|post-commit|prepare-commit-msg|pre-push)/i,
    );
    const hookName = match?.[1] ?? "git hook";
    return `${hookName} hook failed:\n${cleaned}`;
  }
  return cleaned;
}

/**
 * Apply a commit plan - creates local git commits
 *
 * @param cwd - Working directory (repo root)
 * @param plan - Commit plan to apply
 * @param options - Apply options
 * @returns Apply result with created commit SHAs
 */
export async function applyCommitPlan(
  cwd: string,
  plan: CommitPlan,
  options?: ApplyOptions,
): Promise<ApplyResult> {
  const appliedCommits: ApplyResult["appliedCommits"] = [];
  const errors: string[] = [];
  const logger = useLogger();
  const planFileCount = plan.commits.reduce((sum, c) => sum + c.files.length, 0);

  await logger.info("apply: start", {
    scope: options?.scope,
    cwd,
    commits: plan.commits.length,
    planFiles: planFileCount,
    force: !!options?.force,
  });

  // 0. Validate plan integrity before touching git state.
  const integrityErrors = validatePlanIntegrity(plan);
  if (integrityErrors.length > 0) {
    await logger.warn("apply: plan integrity failed", { errors: integrityErrors });
    return {
      success: false,
      appliedCommits: [],
      errors: integrityErrors,
    };
  }

  // 1. Check for staleness (only for files in the plan, not entire repo)
  if (!options?.force) {
    const staleness = await checkPlanStaleness(cwd, plan, options?.scope);
    if (staleness.isStale) {
      return {
        success: false,
        appliedCommits: [],
        errors: [staleness.reason],
      };
    }
  }

  // 2. Apply each commit in order
  for (const commit of plan.commits) {
    try {
      const sha = await applyCommit(cwd, commit);
      appliedCommits.push({
        groupId: commit.id,
        sha,
        message: formatCommitMessage(commit),
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to apply commit ${commit.id}: ${formatCommitError(raw)}`);

      // Stop on first error - don't leave repo in inconsistent state
      break;
    }
  }

  return {
    success: errors.length === 0,
    appliedCommits,
    errors,
  };
}

/**
 * Apply a single commit
 * Supports nested git repositories - files with 'nested-repo/...' prefix will be committed in the nested repo
 */
async function applyCommit(cwd: string, commit: CommitGroup): Promise<string> {
  // Group files by repository (root vs nested)
  const filesByRepo = groupFilesByRepo(cwd, commit.files);

  // For now, we only support commits within a single repo
  // If files span multiple repos, we need to handle that differently
  const repos = Array.from(filesByRepo.keys());

  if (repos.length > 1) {
    throw new Error(
      "Commit spans multiple repositories. Split into separate commits.",
    );
  }

  const [repoPath, fileInfos] = Array.from(filesByRepo.entries())[0]!;
  const git: SimpleGit = simpleGit(repoPath);

  // Unstage all currently staged files so only plan files end up in the commit.
  // restore --staged requires HEAD; fall back to rm --cached for fresh repos.
  const statusBefore = await git.status();
  if (statusBefore.staged.length > 0) {
    const restored = await git
      .raw(["restore", "--staged", "--", ...statusBefore.staged])
      .then(() => true)
      .catch(() => false);
    if (!restored) {
      for (const f of statusBefore.staged) {
        await git.raw(["rm", "--cached", "--", f]).catch(() => {});
      }
    }
  }

  // Stage the files for this commit, handling gitignored-but-tracked files
  for (const { relativePath } of fileInfos) {
    try {
      await git.add(relativePath);
    } catch (addErr) {
      const msg = addErr instanceof Error ? addErr.message : String(addErr);
      if (msg.includes("ignored by one of your .gitignore files")) {
        // File is inside a gitignored directory — check if it's tracked (previously committed)
        const isTracked = await git
          .raw(["ls-files", "--error-unmatch", relativePath])
          .then(() => true)
          .catch(() => false);
        if (isTracked) {
          await git.raw(["add", "-f", relativePath]);
        } else {
          throw new Error(
            `File is gitignored and untracked, cannot stage: ${relativePath}`,
          );
        }
      } else {
        throw new Error(cleanGitError(msg));
      }
    }
  }

  // Verify something was actually staged for this commit
  const statusAfterAdd = await git.status();
  const stagedSet = new Set(statusAfterAdd.staged);
  const anyStagedForCommit = fileInfos.some((fi) =>
    stagedSet.has(fi.relativePath),
  );
  if (!anyStagedForCommit) {
    throw new Error(
      `Nothing staged for this commit — files may already be committed or have no changes`,
    );
  }

  // Commit only the plan files (staging area contains exclusively those at this point)
  const message = formatCommitMessage(commit);
  const result = await git.commit(message);

  return result.commit;
}

/** Commit footer for branding */
const COMMIT_FOOTER = "\n\n🤖 Generated by kb-labs-commit-plugin";

/**
 * Format commit message following conventional commits
 */
export function formatCommitMessage(
  commit: CommitGroup,
  options?: { includeFooter?: boolean },
): string {
  const type = commit.type;
  const scope = commit.scope ? `(${commit.scope})` : "";
  const breaking = commit.breaking ? "!" : "";
  const subject = commit.message;

  let message = `${type}${scope}${breaking}: ${subject}`;

  // Add body if present
  if (commit.body) {
    message += `\n\n${commit.body}`;
  }

  // Add branding footer (default: true)
  if (options?.includeFooter !== false) {
    message += COMMIT_FOOTER;
  }

  return message;
}
