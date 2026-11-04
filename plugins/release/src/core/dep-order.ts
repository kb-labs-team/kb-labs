/**
 * Topological ordering of packages by intra-monorepo dependency edges
 * (dependencies + devDependencies + peerDependencies). Used to make sure a package's own
 * workspace dependencies are built before it — a package built out of
 * order can fail to resolve a dependency's subpath exports (e.g.
 * `@kb-labs/sdk/adapters`) if that dependency's dist/ doesn't exist yet
 * (fresh worktree, no pre-existing build cache).
 *
 * Packages are grouped into "waves": wave 0 has no intra-release deps,
 * wave 1 depends only on wave 0, etc. Cycles (should not exist in a
 * well-formed monorepo) fall into a "remainder" group appended at the end.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OrderablePackage {
  name: string;
  path: string;
}

function buildIntraDeps<T extends OrderablePackage>(packages: T[], nameSet: Set<string>): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const intra = new Set<string>();
    try {
      const pkgJson = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        for (const depName of Object.keys(pkgJson[section] ?? {})) {
          // A package's self-reference resolves within its own package and cannot
          // be a distinct build prerequisite. Keeping it as an edge creates a
          // self-cycle that stalls ordering for the rest of the release flow.
          if (depName !== pkg.name && nameSet.has(depName)) { intra.add(depName); }
        }
      }
    } catch {
      // If we can't read package.json, treat as no deps
    }
    deps.set(pkg.name, intra);
  }
  return deps;
}

function buildDependantsMap(names: string[], deps: Map<string, Set<string>>): Map<string, Set<string>> {
  const dependants = new Map<string, Set<string>>();
  for (const name of names) {
    for (const dep of deps.get(name) ?? []) {
      if (!dependants.has(dep)) { dependants.set(dep, new Set()); }
      dependants.get(dep)!.add(name);
    }
  }
  return dependants;
}

/**
 * Sort packages so every intra-release dependency appears before its
 * dependants. Flat order (not waves) — safe for a sequential build loop.
 */
export function topoSortForBuild<T extends OrderablePackage>(packages: T[]): T[] {
  const byName = new Map(packages.map(p => [p.name, p]));
  const nameSet = new Set(packages.map(p => p.name));
  const deps = buildIntraDeps(packages, nameSet);
  const dependants = buildDependantsMap([...nameSet], deps);

  const remaining = new Map<string, number>(
    packages.map(p => [p.name, (deps.get(p.name) ?? new Set()).size]),
  );
  const ordered: T[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, count]) => count === 0)
      .map(([name]) => name);

    if (ready.length === 0) {
      // Cycle (or unresolved dep outside the plan) — append the rest as-is.
      for (const name of remaining.keys()) { ordered.push(byName.get(name)!); }
      break;
    }

    for (const name of ready) {
      ordered.push(byName.get(name)!);
      remaining.delete(name);
      for (const dependant of dependants.get(name) ?? []) {
        if (remaining.has(dependant)) {
          remaining.set(dependant, (remaining.get(dependant) ?? 1) - 1);
        }
      }
    }
  }

  return ordered;
}
