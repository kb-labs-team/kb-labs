import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import type { DevlinkPlan } from '../../contracts/index.js';

type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface ApplyOptions {
  dryRun?: boolean;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Applies a DevlinkPlan to package.json files on disk.
 * Groups changes by file to minimize I/O operations.
 */
export async function applyPlan(plan: DevlinkPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const { dryRun = false } = options;

  // Group items by packageJsonPath
  const byFile = new Map<string, typeof plan.items>();
  for (const item of plan.items) {
    if (!byFile.has(item.packageJsonPath)) {byFile.set(item.packageJsonPath, []);}
    byFile.get(item.packageJsonPath)!.push(item);
  }

  let applied = 0;
  let skipped = 0;
  const errors: ApplyResult['errors'] = [];

  for (const [filePath, items] of byFile.entries()) {
    if (!existsSync(filePath)) {
      skipped++;
      continue;
    }

    if (dryRun) {
      applied += items.length;
      continue;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const pkg = JSON.parse(raw) as PackageJson;

      for (const item of items) {
        const section = pkg[item.section as DepSection];
        if (section && item.depName in section) {
          section[item.depName] = item.to;
          applied++;
        } else {
          skipped++;
        }
      }

      // Write back with same trailing newline and 2-space indent
      const trailingNewline = raw.endsWith('\n') ? '\n' : '';
      writeFileSync(filePath, JSON.stringify(pkg, null, 2) + trailingNewline, 'utf-8');
    } catch (err) {
      errors.push({ file: filePath, error: String(err) });
    }
  }

  return { applied, skipped, errors };
}

/**
 * Checks if the given directory has uncommitted git changes.
 * Returns a list of modified files, or empty array if clean.
 */
export function checkGitDirty(repoPath: string): string[] {
  try {
    const output = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => line.slice(3).trim());
  } catch {
    return []; // Not a git repo or git not available
  }
}
