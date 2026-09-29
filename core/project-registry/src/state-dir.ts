import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isProjectId } from './project-id.js';
import { PROJECT_REGISTRY_FILE, parseRegistryFile, projectStateDir, resolveKbHome } from './registry.js';

/** Where machine-level state lives: `$KB_HOME` (or `~/.kb`) unless `root` is given. */
export interface ProjectStateOptions {
  /** Machine-level root. Defaults to `resolveKbHome(env)`. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Stable registry ID; set by managed runtimes and the CLI after cwd resolution. */
  projectId?: string;
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
 * Registered projects resolve through their stable registry ID. An explicit
 * ID from a CLI cwd lookup or managed runtime takes precedence. Unregistered
 * development workspaces use a private deterministic fallback ID.
 */
export function resolveProjectStateDir(projectRoot: string, options: ProjectStateOptions = {}): string {
  const root = options.root ? resolve(options.root) : resolveKbHome(options.env);
  const projectId = resolveProjectId(projectRoot, root, options);
  return projectStateDir(root, projectId);
}

function resolveProjectId(projectRoot: string, registryRoot: string, options: ProjectStateOptions): string {
  const explicit = options.projectId ?? options.env?.KB_PROJECT_ID ?? process.env.KB_PROJECT_ID;
  if (explicit !== undefined) {
    if (!isProjectId(explicit)) {
      throw new Error(`KB_PROJECT_ID is not a valid project id: ${explicit}`);
    }
    return explicit;
  }

  const canonical = canonicalProjectRootSync(projectRoot);
  const registryPath = join(registryRoot, PROJECT_REGISTRY_FILE);
  try {
    const registry = parseRegistryFile(readFileSync(registryPath, 'utf8'), registryPath);
    const candidates = registry.projects.filter((project) => {
      const rel = relative(project.path, canonical);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    candidates.sort((left, right) => right.path.length - left.path.length);
    if (candidates[0]) {
      return candidates[0].id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Unregistered development workspaces still need isolated deterministic
  // runtime storage. Registered projects always use their opaque registry ID.
  const digest = createHash('sha256').update(canonical.normalize('NFC'), 'utf8').digest('hex');
  return `prj_${digest.slice(0, 32)}`;
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
