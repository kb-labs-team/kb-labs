import type { ShellAPI } from '@kb-labs/sdk';
import type { SnapshotGit } from '../../contracts/index.js';

/**
 * Capture current git context using ctx.api.shell.
 * Returns undefined if the directory is not a git repo or git is unavailable.
 */
export async function captureGit(shell: ShellAPI, cwd: string): Promise<SnapshotGit | undefined> {
  try {
    const [commitRes, branchRes, messageRes] = await Promise.all([
      shell.exec('git', ['rev-parse', '--short', 'HEAD'], { cwd, throwOnError: false }),
      shell.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, throwOnError: false }),
      shell.exec('git', ['log', '-1', '--format=%s'], { cwd, throwOnError: false }),
    ]);

    if (!commitRes.ok) {return undefined;}

    return {
      commit:  commitRes.stdout.trim(),
      branch:  branchRes.stdout.trim() || 'HEAD',
      message: messageRes.stdout.trim(),
    };
  } catch {
    return undefined;
  }
}
