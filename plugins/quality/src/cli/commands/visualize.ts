/**
 * quality:visualize - Visualize dependency graph
 *
 * Shows dependency graph in various formats:
 * - Tree view for specific package
 * - DOT format for graphviz
 * - Statistics about the graph
 */

import { defineCommand, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import type { PluginHandlerUIFacade } from '@kb-labs/sdk';
import {
  buildDependencyGraph,
  getReverseDependencies,
  getImpactAnalysis,
  type DependencyGraph,
} from '../../core/graph/index.js';

type VisualizeFlags = {
  package?: string;
  tree?: boolean;
  dot?: boolean;
  stats?: boolean;
  reverse?: boolean;
  impact?: boolean;
  json?: boolean;
  argv?: string[];
};

type VisualizeInput = VisualizeFlags & { argv?: string[] };

export default defineCommand({
  id: 'quality:visualize',
  description: 'Visualize dependency graph',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: VisualizeInput): Promise<CommandResult<{ graph: DependencyGraph }>> {
      const { ui } = ctx;

      // V3: Flags may come wrapped in input.flags or passed directly
      const flags = ('flags' in input && typeof (input as { flags?: unknown }).flags === 'object' && (input as { flags?: unknown }).flags !== null)
        ? (input as { flags: VisualizeInput }).flags
        : input;

      // Build dependency graph
      const graph = buildDependencyGraph(ctx.cwd);

      // Handle different output modes
      if (flags.dot) {
        outputDot(graph, flags, ui);
      } else if (flags.tree && flags.package) {
        outputTree(graph, flags.package, flags, ui);
      } else if (flags.reverse && flags.package) {
        outputReverse(graph, flags.package, flags, ui);
      } else if (flags.impact && flags.package) {
        outputImpact(graph, flags.package, flags, ui);
      } else if (flags.stats) {
        outputStats(graph, flags, ui);
      } else {
        // Default: show stats
        outputStats(graph, flags, ui);
      }

      return { graph };
    },
  },
});

/**
 * Output dependency tree for a package
 */
function outputTree(graph: DependencyGraph, packageName: string, flags: VisualizeFlags, ui: PluginHandlerUIFacade | undefined) {
  const { nodes } = graph;
  const node = nodes.get(packageName);

  if (!node) {
    return;
  }

  const sections: Array<{ header: string; items: string[] }> = [];

  // Build tree recursively
  const visited = new Set<string>();
  const treeItems: string[] = [];

  function buildTree(pkg: string, depth: number, prefix: string) {
    if (visited.has(pkg)) {
      treeItems.push(`${prefix}${pkg} (circular)`);
      return;
    }
    visited.add(pkg);

    const pkgNode = nodes.get(pkg);
    if (!pkgNode) {return;}

    treeItems.push(`${prefix}${pkg}`);

    const deps = Array.from(pkgNode.deps);
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i];
      if (!dep) {continue;}
      const isLast = i === deps.length - 1;
      const newPrefix = prefix + (isLast ? '  └─ ' : '  ├─ ');
      buildTree(dep, depth + 1, newPrefix);
    }
  }

  buildTree(packageName, 0, '');

  sections.push({
    header: 'Dependency Tree',
    items: treeItems,
  });

  ui?.success?.('Dependency tree generated', {
    title: `📦 Dependency Tree for ${packageName}`,
    sections,
  });
}

/**
 * Output reverse dependencies (who depends on this package)
 */
function outputReverse(graph: DependencyGraph, packageName: string, flags: VisualizeFlags, ui: PluginHandlerUIFacade | undefined) {
  const reverseDeps = getReverseDependencies(graph, packageName);

  if (flags.json) {
    return;
  }

  const sections: Array<{ header: string; items: string[] }> = [];

  if (reverseDeps.size === 0) {
    sections.push({
      header: 'Result',
      items: ['No packages depend on this package'],
    });
  } else {
    sections.push({
      header: `Packages that depend on ${packageName}`,
      items: Array.from(reverseDeps).map(dep => `• ${dep}`),
    });
  }

  ui?.success?.('Reverse dependencies found', {
    title: `⬅️ Reverse Dependencies for ${packageName}`,
    sections,
  });
}

/**
 * Output impact analysis (all packages affected by changes)
 */
function outputImpact(graph: DependencyGraph, packageName: string, flags: VisualizeFlags, ui: PluginHandlerUIFacade | undefined) {
  const affected = getImpactAnalysis(graph, packageName);

  if (flags.json) {
    return;
  }

  const sections: Array<{ header: string; items: string[] }> = [];

  if (affected.size === 0) {
    sections.push({
      header: 'Result',
      items: ['No other packages affected by changes to this package'],
    });
  } else {
    sections.push({
      header: `Impact Analysis for ${packageName}`,
      items: [
        `Changes to this package will affect ${affected.size} other packages:`,
        '',
        ...Array.from(affected).map(dep => `• ${dep}`),
      ],
    });

    sections.push({
      header: 'Recommendations',
      items: [
        '🧪 Run tests in affected packages',
        '🔨 Rebuild affected packages',
        '📝 Update documentation if API changed',
      ],
    });
  }

  ui?.success?.('Impact analysis completed', {
    title: `💥 Impact Analysis for ${packageName}`,
    sections,
  });
}

/**
 * Output dependency graph statistics
 */
function outputStats(graph: DependencyGraph, flags: VisualizeFlags, ui: PluginHandlerUIFacade | undefined) {
  const { nodes } = graph;

  // Calculate statistics
  let totalDeps = 0;
  let maxDeps = 0;
  let maxDepsPackage = '';
  const depCounts = new Map<number, number>();

  for (const [name, node] of nodes) {
    const depCount = node.deps.size;
    totalDeps += depCount;

    if (depCount > maxDeps) {
      maxDeps = depCount;
      maxDepsPackage = name;
    }

    depCounts.set(depCount, (depCounts.get(depCount) ?? 0) + 1);
  }

  const avgDeps = nodes.size > 0 ? (totalDeps / nodes.size).toFixed(2) : '0';

  if (flags.json) {
    return;
  }

  const sections: Array<{ header: string; items: string[] }> = [];

  sections.push({
    header: 'Graph Statistics',
    items: [
      `Total packages: ${nodes.size}`,
      `Total dependencies: ${totalDeps}`,
      `Average dependencies per package: ${avgDeps}`,
      `Max dependencies: ${maxDeps} (${maxDepsPackage})`,
    ],
  });

  // Dependency distribution
  const distributionItems: string[] = [];
  const sortedCounts = Array.from(depCounts.entries()).sort((a, b) => a[0] - b[0]);
  for (const [count, packages] of sortedCounts) {
    const bar = '█'.repeat(Math.min(packages, 20));
    distributionItems.push(`${count} deps: ${bar} ${packages} packages`);
  }

  sections.push({
    header: 'Dependency Distribution',
    items: distributionItems,
  });

  ui?.success?.('Graph statistics calculated', {
    title: '📊 Dependency Graph Statistics',
    sections,
  });
}

/**
 * Output DOT format for graphviz
 */
function outputDot(graph: DependencyGraph, flags: VisualizeFlags, ui: PluginHandlerUIFacade | undefined) {
  const { nodes } = graph;

  const lines: string[] = [];
  lines.push('digraph dependencies {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box];');
  lines.push('');

  for (const [name, node] of nodes) {
    for (const dep of node.deps) {
      const safeName = name.replace(/[@\/]/g, '_');
      const safeDep = dep.replace(/[@\/]/g, '_');
      lines.push(`  "${safeName}" -> "${safeDep}";`);
    }
  }

  lines.push('}');

  if (flags.json) {
  } else {
    for (const line of lines) {
      ui?.write?.(line);
    }
    ui?.write?.('');
    ui?.write?.('# Save to file and visualize with:');
    ui?.write?.('# dot -Tpng dependencies.dot -o dependencies.png');
  }
}
