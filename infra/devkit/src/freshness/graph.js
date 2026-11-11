/**
 * Dependency graph building with workspace and link resolution
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve workspace:* or link: dependency to actual package metadata
 */
function resolveDependency(depName, depSpec, pkgDirMap, metadata, packageDir) {
  // Case 1: workspace:* -> look up by name
  if (depSpec === 'workspace:*' || depSpec.startsWith('workspace:')) {
    return metadata.get(depName);
  }

  // Case 2: link:../../path -> resolve relative path
  if (depSpec.startsWith('link:')) {
    const linkPath = depSpec.replace('link:', '');

    // Resolve relative path from packageDir
    const absoluteLinkPath = path.resolve(packageDir, linkPath);

    // Try to find package.json at that path
    const packageJsonPath = path.join(absoluteLinkPath, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      try {
        const linkedPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const linkedPackageName = linkedPackageJson.name;

        if (linkedPackageName && metadata.has(linkedPackageName)) {
          return metadata.get(linkedPackageName);
        }
      } catch (err) {
        // Failed to read linked package.json
      }
    }

    // Fallback: try to match by path pattern
    for (const [pkgName, dir] of pkgDirMap) {
      if (absoluteLinkPath === dir || absoluteLinkPath.endsWith(path.basename(dir))) {
        return metadata.get(pkgName);
      }
    }
  }

  // Case 3: Exact version or other spec (try to find by name)
  return metadata.get(depName);
}

/**
 * Build dependency graph
 */
export function buildDependencyGraph(metadata) {
  const graph = new Map(); // pkgName -> GraphNode
  const pkgDirMap = new Map(); // pkgName -> directory

  // First pass: Create nodes
  for (const [pkgName, meta] of metadata) {
    graph.set(pkgName, {
      name: pkgName,
      meta,
      dependencies: new Map(), // depName -> resolvedMeta
      dependents: new Set(),   // Set of pkgNames that depend on this
    });
    pkgDirMap.set(pkgName, meta.dir);
  }

  // Second pass: Resolve dependencies
  for (const [pkgName, node] of graph) {
    const deps = { ...node.meta.dependencies, ...node.meta.devDependencies };

    for (const [depName, depSpec] of Object.entries(deps)) {
      // Skip external dependencies
      if (!depName.startsWith('@kb-labs/')) {continue;}

      // Resolve workspace:* and link: references
      const resolvedMeta = resolveDependency(
        depName,
        depSpec,
        pkgDirMap,
        metadata,
        node.meta.dir
      );

      if (resolvedMeta) {
        node.dependencies.set(depName, resolvedMeta);

        // Add reverse edge
        const depNode = graph.get(depName);
        if (depNode) {
          depNode.dependents.add(pkgName);
        }
      }
    }
  }

  return graph;
}

/**
 * Topological sort for build order suggestion
 */
export function topologicalSort(packageNames, graph) {
  const result = [];
  const visited = new Set();
  const temp = new Set();

  function visit(pkgName) {
    if (temp.has(pkgName)) {
      // Circular dependency - skip this iteration
      return;
    }
    if (visited.has(pkgName)) {return;}

    temp.add(pkgName);

    const node = graph.get(pkgName);
    if (node) {
      for (const [depName] of node.dependencies) {
        if (packageNames.includes(depName)) {
          visit(depName);
        }
      }
    }

    temp.delete(pkgName);
    visited.add(pkgName);
    result.push(pkgName);
  }

  for (const pkg of packageNames) {
    if (!visited.has(pkg)) {
      visit(pkg);
    }
  }

  return result;
}
