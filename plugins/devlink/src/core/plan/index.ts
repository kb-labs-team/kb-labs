import { readFileSync, existsSync } from 'fs';
import { relative, dirname, resolve } from 'path';
import type {
  DevlinkMode,
  DevlinkPlan,
  DevlinkPlanItem,
  PackageEntry,
  PackageMap,
} from '../../contracts/index.js';
import type { MonorepoInfo } from '../discovery/index.js';
import { resolvePackageMonorepo } from '../discovery/index.js';

type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Builds a DevlinkPlan — all package.json changes needed for the target mode.
 */
export function buildPlan(
  mode: DevlinkMode,
  packageMap: PackageMap,
  monorepos: MonorepoInfo[],
  rootDir: string,
  options: { scopedRepos?: string[] } = {}
): DevlinkPlan {
  const items: DevlinkPlanItem[] = [];
  const filteredMonorepos = options.scopedRepos?.length
    ? monorepos.filter(m => options.scopedRepos!.includes(m.name))
    : monorepos;

  for (const monorepo of filteredMonorepos) {
    for (const pkgPath of monorepo.packagePaths) {
      if (!existsSync(pkgPath)) {continue;}

      let pkg: PackageJson;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
      } catch {
        continue;
      }

      const sections: DepSection[] = ['dependencies', 'devDependencies', 'peerDependencies'];
      for (const section of sections) {
        const deps = pkg[section];
        if (!deps) {continue;}

        for (const [depName, currentValue] of Object.entries(deps)) {
          const entry = packageMap[depName];
          if (!entry) {continue;} // Not a cross-repo dep

          // Skip bare * — ambiguous wildcard, not a versioned dep we manage
          if (currentValue === '*') {continue;}

          // workspace:* — only skip if intra-repo (same monorepo handles it via pnpm)
          // Cross-repo workspace:* must be converted to link: or ^version
          if (currentValue.startsWith('workspace:')) {
            const consumerMono = resolvePackageMonorepo(pkgPath, monorepos);
            if (consumerMono && consumerMono.name === entry.monorepo) {continue;}
          }

          const targetValue = getTargetValue(mode, entry, pkgPath, rootDir);
          if (targetValue === currentValue) {continue;} // Already correct

          items.push({
            packageJsonPath: pkgPath,
            packageJsonRel: relative(rootDir, pkgPath),
            monorepo: monorepo.name,
            depName,
            from: currentValue,
            to: targetValue,
            section,
          });
        }
      }
    }
  }

  return {
    mode,
    items,
    timestamp: new Date().toISOString(),
    ...(options.scopedRepos?.length ? { scopedRepos: options.scopedRepos } : {}),
  };
}

/**
 * Computes the target value for a dependency based on mode.
 * Private packages always stay as link: (not published to npm).
 */
function getTargetValue(
  mode: DevlinkMode,
  entry: PackageEntry,
  fromPackageJson: string,
  rootDir: string
): string {
  // npm mode: use ^version, but private packages stay as link: (not on npm)
  if (mode === 'npm' && !entry.private) {
    return entry.npmVersion;
  }

  // local, auto, or private in npm mode: use link: path
  const fromDir = dirname(fromPackageJson);
  const targetDir = resolve(rootDir, entry.linkPath);
  const relPath = relative(fromDir, targetDir);
  const normalized = relPath.startsWith('.') ? relPath : `./${relPath}`;
  return `link:${normalized}`;
}

/**
 * Returns a human-readable description of a plan item change.
 */
export function describeChange(item: DevlinkPlanItem): string {
  return `${item.depName}: ${item.from} → ${item.to}`;
}

/**
 * Groups plan items by monorepo for display purposes.
 */
export function groupByMonorepo(items: DevlinkPlanItem[]): Map<string, DevlinkPlanItem[]> {
  const groups = new Map<string, DevlinkPlanItem[]>();
  for (const item of items) {
    if (!groups.has(item.monorepo)) {groups.set(item.monorepo, []);}
    groups.get(item.monorepo)!.push(item);
  }
  return groups;
}
