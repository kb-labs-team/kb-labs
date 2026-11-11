/**
 * POST /graph handler
 *
 * Visualize dependency graph in different modes:
 * - tree: dependency tree for package
 * - reverse: who depends on this package
 * - impact: what will be affected by changes
 * - stats: graph statistics
 */

import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  buildDependencyGraph,
  getReverseDependencies,
  getImpactAnalysis,
  type DependencyGraph,
} from '../../core/graph/index.js';

export type GraphRequest = {
  packageName?: string;
  mode: 'tree' | 'reverse' | 'impact' | 'stats';
};

export type GraphResponse = {
  mode: string;
  packageName?: string;
  tree?: DependencyTree;
  packages?: string[];
  stats?: GraphStats;
};

export type DependencyTree = {
  name: string;
  children: DependencyTree[];
};

export type GraphStats = {
  totalPackages: number;
  maxDepth: number;
  avgDependencies: number;
  mostDepended: Array<{ name: string; count: number }>;
};

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<GraphRequest, unknown>
  ): Promise<GraphResponse> {
    try {
      const { packageName, mode } = input.query ?? { mode: 'stats' };

      // Build dependency graph (cached with Map serialization)
      const cacheKey = `quality:graph:${ctx.cwd}`;
      const cached = await ctx.platform.cache.get<any>(cacheKey);

      let graph: DependencyGraph;

      if (cached) {
        // Deserialize: convert plain object back to Map
        graph = {
          nodes: new Map(Object.entries(cached.nodes).map(([key, value]: [string, any]) => [
            key,
            {
              ...value,
              deps: new Set(value.deps),
              devDeps: value.devDeps ? new Set(value.devDeps) : undefined,
              dependents: new Set(value.dependents),
            },
          ])),
          workspacePackages: new Set(cached.workspacePackages),
        };
      } else {
        graph = buildDependencyGraph(ctx.cwd);

        // Serialize: convert Map to plain object for Redis
        const serialized = {
          nodes: Object.fromEntries(
            Array.from(graph.nodes.entries()).map(([key, value]) => [
              key,
              {
                ...value,
                deps: Array.from(value.deps),
                devDeps: value.devDeps ? Array.from(value.devDeps) : undefined,
                dependents: Array.from(value.dependents),
              },
            ])
          ),
          workspacePackages: Array.from(graph.workspacePackages),
        };

        // Cache for 2 minutes
        await ctx.platform.cache.set(cacheKey, serialized, 120000);
      }

      // Handle different modes
      if (mode === 'stats') {
        return {
          mode,
          stats: calculateGraphStats(graph),
        };
      }

      if (mode === 'tree') {
        if (!packageName) {
          // Find root packages (packages that have no dependents - nothing depends on them)
          const rootPackages: string[] = [];
          for (const [name, node] of graph.nodes) {
            if (node.dependents.size === 0) {
              rootPackages.push(name);
            }
          }

          return {
            mode,
            tree: {
              name: 'Root Packages',
              children: rootPackages.map(pkg => buildDependencyTree(graph, pkg)),
            },
          };
        }
        return {
          mode,
          packageName,
          tree: buildDependencyTree(graph, packageName),
        };
      }

      if (!packageName) {
        throw new Error('packageName is required for reverse and impact modes');
      }

      if (mode === 'reverse') {
        const reverseDeps = getReverseDependencies(graph, packageName);
        return {
          mode,
          packageName,
          packages: Array.from(reverseDeps),
        };
      }

      if (mode === 'impact') {
        const affected = getImpactAnalysis(graph, packageName);
        return {
          mode,
          packageName,
          packages: Array.from(affected),
        };
      }

      throw new Error(`Unknown mode: ${mode}`);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});

/**
 * Build dependency tree recursively
 */
function buildDependencyTree(
  graph: DependencyGraph,
  packageName: string,
  visited: Set<string> = new Set()
): DependencyTree {
  const node = graph.nodes.get(packageName);
  if (!node) {
    return { name: packageName, children: [] };
  }

  if (visited.has(packageName)) {
    return { name: `${packageName} (circular)`, children: [] };
  }

  visited.add(packageName);

  const children = Array.from(node.deps).map(dep =>
    buildDependencyTree(graph, dep, new Set(visited))
  );

  return {
    name: packageName,
    children,
  };
}

/**
 * Calculate graph statistics
 */
function calculateGraphStats(graph: DependencyGraph): GraphStats {
  const { nodes } = graph;

  // Calculate average dependencies
  let totalDeps = 0;
  for (const node of nodes.values()) {
    totalDeps += node.deps.size;
  }
  const avgDeps = nodes.size > 0 ? totalDeps / nodes.size : 0;

  // Calculate max depth (longest dependency chain)
  let maxDepth = 0;
  for (const [name] of nodes) {
    const depth = calculateDepth(graph, name, new Set());
    if (depth > maxDepth) {
      maxDepth = depth;
    }
  }

  // Find most depended on packages (packages with most dependents)
  const dependentCounts = new Map<string, number>();
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      dependentCounts.set(dep, (dependentCounts.get(dep) ?? 0) + 1);
    }
  }

  const mostDepended = Array.from(dependentCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5); // Top 5

  return {
    totalPackages: nodes.size,
    maxDepth,
    avgDependencies: Number.parseFloat(avgDeps.toFixed(2)),
    mostDepended,
  };
}

/**
 * Calculate depth of dependency chain from a package
 */
function calculateDepth(
  graph: DependencyGraph,
  packageName: string,
  visited: Set<string>
): number {
  const node = graph.nodes.get(packageName);
  if (!node || visited.has(packageName)) {
    return 0;
  }

  visited.add(packageName);

  let maxChildDepth = 0;
  for (const dep of node.deps) {
    const depth = calculateDepth(graph, dep, new Set(visited));
    if (depth > maxChildDepth) {
      maxChildDepth = depth;
    }
  }

  return 1 + maxChildDepth;
}
