import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { deriveProjectId } from './project-id.js';
import { projectStateDir, resolveKbHome } from './registry.js';

/** Where machine-level state lives: `$KB_HOME` (or `~/.kb`) unless `root` is given. */
export interface ProjectStateOptions {
  /** Machine-level root. Defaults to `resolveKbHome(env)`. */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Canonical absolute path of a project folder, synchronously. Symlinks are
 * resolved. A folder that does not exist yet is canonicalized through its
 * nearest existing ancestor, so `/tmp/x` and `/private/tmp/x` agree on macOS
 * whether or not `x` has been created.
 */
function canonicalProjectRootSync(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) {
        return absolute;
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * `<KB_HOME or ~/.kb>/state/<projectId>/` for a project folder — path only,
 * nothing is created.
 *
 * The project id is derived from the canonical path (ADR-0044), which is
 * exactly the id a registered project carries, so registered and unregistered
 * projects resolve to the same directory and registering a project later does
 * not orphan the state written before.
 */
export function resolveProjectStateDir(projectRoot: string, options: ProjectStateOptions = {}): string {
  const root = options.root ? resolve(options.root) : resolveKbHome(options.env);
  return projectStateDir(root, deriveProjectId(canonicalProjectRootSync(projectRoot)));
}

/**
 * Location of a runtime-state entry inside the project state directory, e.g.
 * `['cache', 'cli-manifests.json']`. Nothing is created and the repository is
 * never consulted: files an older version left in `<project>/.kb/` are ignored.
 */
export function resolveRuntimeStatePath(
  projectRoot: string,
  segments: readonly string[],
  options: ProjectStateOptions = {},
): string {
  return join(resolveProjectStateDir(projectRoot, options), ...segments);
}
