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
export function resolveDevkitBin(rootDir: string, configPath?: string): string {
  if (configPath) {
    const full = configPath.startsWith('/') ? configPath : join(rootDir, configPath);
    if (!existsSync(full)) {
      throw new Error(`devkitPath "${configPath}" not found at ${full}`);
    }
    return full;
  }

  const local = join(rootDir, 'tools', 'kb-devkit', 'kb-devkit');
  if (existsSync(local)) {return local;}

  return 'kb-devkit';
}
