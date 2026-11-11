import { scanWorkspace } from '../workspace/scan-workspace.js';
import type { QualityLayerMap } from '../../contracts/index.js';

export interface BuildOrderOptions {
  rootDir: string;
  layerMap?: QualityLayerMap;
  /** Limit to transitive deps of this package */
  filterPackage?: string;
}

export interface BuildOrderResult {
  layers: string[][];
  sorted: string[];
  circular: string[][];
  packageCount: number;
  layerCount: number;
  hasCircular: boolean;
}

export function analyzeBuildOrder(opts: BuildOrderOptions): BuildOrderResult {
  const { rootDir, layerMap, filterPackage } = opts;

  const packages = scanWorkspace(rootDir, layerMap);
  const allNames = new Set(packages.map(p => p.name));

  // Use only production deps for build ordering (devDeps don't affect build output)
  const deps = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const wsDeps = new Set(pkg.deps.filter(d => allNames.has(d)));
    deps.set(pkg.name, wsDeps);
  }

  let names: string[];
  if (filterPackage && allNames.has(filterPackage)) {
    const visited = new Set<string>();
    const visit = (n: string) => {
      if (visited.has(n)) {return;}
      visited.add(n);
      for (const d of deps.get(n) ?? []) {visit(d);}
    };
    visit(filterPackage);
    names = [...visited];
  } else {
    names = packages.map(p => p.name);
  }

  // Kahn's algorithm — inDegree[n] = number of workspace deps n needs built first
  const nameSet = new Set(names);
  const inDegree = new Map<string, number>();
  for (const n of names) {
    const count = [...(deps.get(n) ?? [])].filter(d => nameSet.has(d)).length;
    inDegree.set(n, count);
  }

  const layers: string[][] = [];
  const sorted: string[] = [];
  const enqueued = new Set<string>();
  let queue = names.filter(n => (inDegree.get(n) ?? 0) === 0);
  for (const n of queue) {enqueued.add(n);}

  while (queue.length > 0) {
    layers.push([...queue]);
    sorted.push(...queue);
    const next: string[] = [];
    for (const d of queue) {
      for (const n of names) {
        if (enqueued.has(n)) {continue;}
        if ((deps.get(n) ?? new Set()).has(d)) {
          const deg = (inDegree.get(n) ?? 1) - 1;
          inDegree.set(n, deg);
          if (deg === 0) {
            next.push(n);
            enqueued.add(n);
          }
        }
      }
    }
    queue = next;
  }

  const circular = names.filter(n => !sorted.includes(n));

  return {
    layers,
    sorted,
    circular: circular.length > 0 ? [circular] : [],
    packageCount: sorted.length,
    layerCount: layers.length,
    hasCircular: circular.length > 0,
  };
}
