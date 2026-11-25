import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the kb-devkit binary path.
 *
 * Resolution order:
 * 1. configPath (from QAPluginConfig.devkitPath) — absolute or relative to rootDir
 * 2. tools/kb-devkit/kb-devkit relative to rootDir (workspace-local copy)
 * 3. "kb-devkit" — resolved from PATH at spawn time
 *
 * The shell permission whitelist matches by basename, so passing a full path
 * to shell.exec() works correctly when allow: ['kb-devkit'] is declared.
 */
export function resolveDevkitBin(rootDir: string, configPath?: string, owningProjectRoot?: string): string {
  if (configPath) {
    if (configPath.startsWith('/')) {
      if (!existsSync(configPath)) {
        throw new Error(`devkitPath "${configPath}" not found at ${configPath}`);
      }
      return configPath;
    }

    const workspacePath = join(rootDir, configPath);
    if (existsSync(workspacePath)) {return workspacePath;}

    if (owningProjectRoot) {
      const projectPath = join(owningProjectRoot, configPath);
      if (existsSync(projectPath)) {return projectPath;}
    }

    throw new Error(`devkitPath "${configPath}" not found at ${workspacePath}`);
  }

  const local = join(rootDir, 'tools', 'kb-devkit', 'kb-devkit');
  if (existsSync(local)) {return local;}

  // Isolated task worktrees often omit ignored build outputs. Resolve the owning
  // project's tool before falling back to PATH, which may contain an older CLI.
  if (owningProjectRoot) {
    const projectLocal = join(owningProjectRoot, 'tools', 'kb-devkit', 'kb-devkit');
    if (existsSync(projectLocal)) {return projectLocal;}
  }

  return 'kb-devkit';
}
