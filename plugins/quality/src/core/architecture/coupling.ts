/**
 * Coupling metrics — Robert Martin's package metrics.
 *
 * Ca (afferent coupling): packages that depend on this package
 * Ce (efferent coupling): packages this package depends on
 * Instability = Ce / (Ca + Ce), range [0, 1]
 *   0 = maximally stable (many dependents, no deps)
 *   1 = maximally unstable (no dependents, many deps)
 */

import type { CouplingReport, PackageCoupling, QualityLayerMap } from '../../contracts/index.js';
import { scanWorkspace } from '../workspace/scan-workspace.js';

export interface CouplingOptions {
  rootDir: string;
  layerMap?: QualityLayerMap;
  /** How many packages to include in mostUnstable / mostCoupled lists */
  topN?: number;
}

export function analyzeCoupling(opts: CouplingOptions): CouplingReport {
  const { rootDir, layerMap, topN = 5 } = opts;

  const packages = scanWorkspace(rootDir, layerMap);
  const allNames = new Set(packages.map(p => p.name));

  // Ca: count how many workspace packages depend on each package
  const afferentCount = new Map<string, number>(packages.map(p => [p.name, 0]));

  for (const pkg of packages) {
    const workspaceDeps = [...pkg.deps, ...pkg.devDeps].filter(d => allNames.has(d));
    for (const dep of workspaceDeps) {
      afferentCount.set(dep, (afferentCount.get(dep) ?? 0) + 1);
    }
  }

  const result: PackageCoupling[] = packages.map(pkg => {
    const ce = [...pkg.deps, ...pkg.devDeps].filter(d => allNames.has(d)).length;
    const ca = afferentCount.get(pkg.name) ?? 0;
    const total = ca + ce;
    const instability = total === 0 ? 0 : ce / total;

    return {
      name: pkg.name,
      afferent: ca,
      efferent: ce,
      instability: Math.round(instability * 100) / 100,
    };
  });

  const avgInstability =
    result.length === 0
      ? 0
      : Math.round((result.reduce((s, p) => s + p.instability, 0) / result.length) * 100) / 100;

  const sorted = [...result].sort((a, b) => b.instability - a.instability);
  const mostUnstable = sorted.slice(0, topN).map(p => ({ ...p }));

  const mostCoupled = [...result]
    .sort((a, b) => b.afferent + b.efferent - (a.afferent + a.efferent))
    .slice(0, topN)
    .map(p => ({ ...p }));

  return { packages: result, avgInstability, mostUnstable, mostCoupled };
}
