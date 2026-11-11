/**
 * File diff utilities
 */

import { simpleGit } from "simple-git";

export interface FileDiff {
  diff: string;
  additions: number;
  deletions: number;
}

/**
 * Get diff for a specific file
 */
export async function getFileDiff(
  cwd: string,
  filePath: string,
): Promise<FileDiff> {
  const git = simpleGit(cwd);

  // Get diff for the specific file
  // git diff HEAD -- <file>
  const diffOutput = await git.diff(["HEAD", "--", filePath]);

  // Count additions and deletions
  const additions = (diffOutput.match(/^\+(?!\+)/gm) || []).length;
  const deletions = (diffOutput.match(/^-(?!-)/gm) || []).length;

  return {
    diff: diffOutput,
    additions,
    deletions,
  };
}
