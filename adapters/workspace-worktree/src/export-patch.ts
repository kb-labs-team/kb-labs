import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspacePatchExport } from '@kb-labs/sdk/adapters';

const execGit = promisify(execFile);
const safeOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];

// Preserve the user's normal ignore configuration when reading source metadata.
// Never let an inherited Git directory, index, config override or trace redirect Git.
export function metadataEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export async function exportGitPatch(
  workspace: string,
  baseCommit: string,
  cancellation?: AbortSignal,
): Promise<WorkspacePatchExport> {
  const deadline = AbortSignal.timeout(120_000);
  const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
  const sourceEnv = metadataEnvironment();
  const git = async (args: string[], env = sourceEnv) => {
    const { stdout } = await execGit('git', [...safeOptions, ...args], {
      cwd: workspace, env, signal, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    });
    return stdout;
  };
  const scratch = await mkdtemp(path.join(tmpdir(), 'kb-worktree-patch-'));
  const gitDir = path.join(scratch, 'repository');
  try {
    const sourcePath = async (name: string) => path.resolve(workspace,
      (await git(['rev-parse', '--git-path', name])).trimEnd());
    const objects = await realpath(await sourcePath('objects'));
    // The temporary repo can read source blobs, but never runs its filters, hooks,
    // fsmonitor helpers, diff drivers, remote helpers, or auto-maintenance.
    const isolated: NodeJS.ProcessEnv = {
      ...sourceEnv,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
    };
    const objectFormat = baseCommit.length === 64 ? 'sha256' : 'sha1';
    await git(['init', '--bare', '--template=', '--object-format=' + objectFormat, gitDir], isolated);
    // A newline-delimited alternates file preserves literal path-list separators.
    if (/[\r\n]/u.test(objects)) throw new Error('Unsupported Git object directory');
    await mkdir(path.join(gitDir, 'info'), { recursive: true });
    await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), objects + '\n');
    const sourceExclude = await sourcePath('info/exclude');
    try {
      await copyFile(sourceExclude, path.join(gitDir, 'info', 'exclude'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const excludes = await git(['config', '--path', '--get', 'core.excludesFile']).catch((error: unknown) => {
      if ((error as { code?: number }).code === 1) return '';
      throw error;
    });
    const excludesFile = excludes.trimEnd();
    const config = excludesFile ? ['-c', 'core.excludesFile=' + path.resolve(workspace, excludesFile)] : [];
    const env = { ...isolated, GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
    await git(['read-tree', baseCommit], env);
    await git([...config, 'add', '--all'], env);
    // A regular patch cannot transport an embedded repository's contents.
    // Git otherwise reports success while omitting its uncommitted files.
    const entries = await git(['ls-files', '--stage', '-z'], env);
    if (entries.split('\0').some((entry) => entry.startsWith('160000 '))) {
      throw new Error('Nested Git workspaces cannot be exported as a single patch');
    }
    const names = await execGit('git', [...safeOptions, 'diff', '--cached', '--no-renames', '--name-only', '-z', baseCommit], {
      cwd: workspace, env, signal, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer',
    });
    const files = new TextDecoder('utf-8', { fatal: true }).decode(names.stdout);
    const patchPath = path.join(scratch, 'workspace.patch');
    const file = await open(patchPath, 'wx', 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('git', [...safeOptions, 'diff', '--cached', '--no-renames', '--binary',
          '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', baseCommit], {
          cwd: workspace, env, signal, stdio: ['ignore', file.fd, 'ignore'],
        });
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Git patch export failed')));
      });
    } finally {
      await file.close();
    }
    const handle = await open(patchPath, 'r');
    try {
      // The reader owns the descriptor. POSIX unlink permits immediate cleanup
      // even when a downstream artifact sink cannot consume the stream.
      await rm(scratch, { recursive: true, force: true });
      return { patch: handle.createReadStream(), baseCommit, changedFiles: files.split('\0').filter(Boolean).sort() };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw Object.assign(new Error('Git could not prepare the workspace patch'), {
      code: 'KB_WORKSPACE_PATCH_EXPORT_FAILED', cause: error,
    });
  }
}
