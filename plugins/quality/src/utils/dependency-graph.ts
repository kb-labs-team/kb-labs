/**
 * Dependency graph utilities for monorepo analysis
 *
 * Provides topological sorting, circular dependency detection,
 * and build order calculation based on workspace dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PackageNode {
  name: string;
  path: string;
  dir: string;
  deps: Set<string>;
  devDeps?: Set<string>;
}

export interface DependencyGraph {
  nodes: Map<string, PackageNode>;
  workspacePackages: Set<string>;
}

export interface TopologicalSortResult {
  layers: string[][]; // Build layers - each layer can build in parallel
  sorted: string[];   // Flattened topological order
  circular: string[][]; // Circular dependency chains
}

/**
 * Build dependency graph from monorepo packages
 */
export function buildDependencyGraph(rootDir: string): DependencyGraph {
  const nodes = new Map<string, PackageNode>();
  const workspacePackages = new Set<string>();

  if (!fs.existsSync(rootDir)) {
    return { nodes, workspacePackages };
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  // First pass: collect all workspace packages
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('kb-labs-')) {continue;}

    const repoPath = path.join(rootDir, entry.name);
    const packagesDir = path.join(repoPath, 'packages');

    if (!fs.existsSync(packagesDir)) {continue;}

    const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true });

    for (const pkgDir of packageDirs) {
      if (!pkgDir.isDirectory()) {continue;}

      const packageJsonPath = path.join(packagesDir, pkgDir.name, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const packageName = pkgJson.name;

        if (packageName) {
          workspacePackages.add(packageName);
        }
      }
    }
  }

  // Second pass: build dependency graph
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('kb-labs-')) {continue;}

    const repoPath = path.join(rootDir, entry.name);
    const packagesDir = path.join(repoPath, 'packages');

    if (!fs.existsSync(packagesDir)) {continue;}

    const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true });

    for (const pkgDir of packageDirs) {
      if (!pkgDir.isDirectory()) {continue;}

      const packageJsonPath = path.join(packagesDir, pkgDir.name, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const packageName = pkgJson.name;

        if (!packageName) {continue;}

        const deps = new Set<string>();
        const devDeps = new Set<string>();

        // Collect workspace dependencies
        const allDeps = {
          ...pkgJson.dependencies,
          ...pkgJson.devDependencies,
        };

        for (const dep of Object.keys(allDeps)) {
          if (workspacePackages.has(dep)) {
            deps.add(dep);
          }
        }

        // Separate dev dependencies
        if (pkgJson.devDependencies) {
          for (const dep of Object.keys(pkgJson.devDependencies)) {
            if (workspacePackages.has(dep)) {
              devDeps.add(dep);
            }
          }
        }

        nodes.set(packageName, {
          name: packageName,
          path: packageJsonPath,
          dir: path.dirname(packageJsonPath),
          deps,
          devDeps,
        });
      }
    }
  }

  return { nodes, workspacePackages };
}

/**
 * Topological sort using Kahn's algorithm
 * Returns build layers where each layer can be built in parallel
 */
export function topologicalSort(graph: DependencyGraph): TopologicalSortResult {
  const { nodes } = graph;
  const layers: string[][] = [];
  const sorted: string[] = [];
  const circular: string[][] = [];

  // Calculate in-degree for each node
  const inDegree = new Map<string, number>();
  for (const [name] of nodes) {
    inDegree.set(name, 0);
  }

  for (const [, node] of nodes) {
    for (const dep of node.deps) {
      if (nodes.has(dep)) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm with layers
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  while (queue.length > 0) {
    const layer: string[] = [...queue];
    layers.push(layer);
    sorted.push(...layer);
    queue.length = 0;

    for (const name of layer) {
      const node = nodes.get(name);
      if (!node) {continue;}

      for (const dep of node.deps) {
        if (nodes.has(dep)) {
          const newDegree = (inDegree.get(dep) ?? 0) - 1;
          inDegree.set(dep, newDegree);
          if (newDegree === 0) {
            queue.push(dep);
          }
        }
      }
    }
  }

  // Check for circular dependencies
  if (sorted.length < nodes.size) {
    const remaining = new Set<string>();
    for (const [name] of nodes) {
      if (!sorted.includes(name)) {
        remaining.add(name);
      }
    }

    // Find cycles using DFS
    const cycles = findCircularDependencies(graph, remaining);
    circular.push(...cycles);
  }

  return { layers, sorted, circular };
}

/**
 * Find circular dependencies using DFS
 */
export function findCircularDependencies(
  graph: DependencyGraph,
  subset?: Set<string>
): string[][] {
  const { nodes } = graph;
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const nodeData = nodes.get(node);
    if (!nodeData) {return;}

    for (const dep of nodeData.deps) {
      if (!nodes.has(dep)) {continue;}
      if (subset && !subset.has(dep)) {continue;}

      if (!visited.has(dep)) {
        dfs(dep, [...path]);
      } else if (recStack.has(dep)) {
        // Found cycle
        const cycleStart = path.indexOf(dep);
        if (cycleStart !== -1) {
          const cycle = path.slice(cycleStart);
          cycles.push([...cycle, dep]);
        }
      }
    }

    recStack.delete(node);
  }

  const nodesToCheck = subset ?? new Set(nodes.keys());
  for (const node of nodesToCheck) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

/**
 * Get build order for a specific package and its dependencies
 */
export function getBuildOrderForPackage(
  graph: DependencyGraph,
  packageName: string
): TopologicalSortResult {
  const { nodes } = graph;

  // Find all dependencies recursively
  const allDeps = new Set<string>();
  const queue = [packageName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    allDeps.add(current);

    const node = nodes.get(current);
    if (!node) {continue;}

    for (const dep of node.deps) {
      if (!allDeps.has(dep) && nodes.has(dep)) {
        queue.push(dep);
      }
    }
  }

  // Create subgraph with only relevant packages
  const subgraph: DependencyGraph = {
    nodes: new Map(),
    workspacePackages: graph.workspacePackages,
  };

  for (const pkg of allDeps) {
    const node = nodes.get(pkg);
    if (node) {
      subgraph.nodes.set(pkg, node);
    }
  }

  return topologicalSort(subgraph);
}

/**
 * Reverse dependency graph - who depends on this package
 */
export function getReverseDependencies(
  graph: DependencyGraph,
  packageName: string
): Set<string> {
  const { nodes } = graph;
  const reverseDeps = new Set<string>();

  for (const [name, node] of nodes) {
    if (node.deps.has(packageName)) {
      reverseDeps.add(name);
    }
  }

  return reverseDeps;
}

/**
 * Get impact analysis - all packages affected by changes to this package
 */
export function getImpactAnalysis(
  graph: DependencyGraph,
  packageName: string
): Set<string> {
  const affected = new Set<string>();
  const queue = [packageName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const reverseDeps = getReverseDependencies(graph, current);

    for (const dep of reverseDeps) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return affected;
}
