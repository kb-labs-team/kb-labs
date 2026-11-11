/**
 * quality:cycles - Detect circular dependencies
 *
 * Uses DFS to find all circular dependency chains in the monorepo.
 */

import { defineCommand, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import {
  buildDependencyGraph,
  findCircularDependencies,
} from '../../core/graph/index.js';

type CyclesFlags = {
  json?: boolean;
  argv?: string[];
};

type CyclesInput = CyclesFlags & { argv?: string[] };

export default defineCommand({
  id: 'quality:cycles',
  description: 'Detect circular dependencies in monorepo',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CyclesInput): Promise<CommandResult<{ cycles: string[][] }>> {
      const { ui } = ctx;

      // V3: Flags may come wrapped in input.flags or passed directly
      const flags = ('flags' in input && typeof (input as { flags?: unknown }).flags === 'object' && (input as { flags?: unknown }).flags !== null)
        ? (input as { flags: CyclesInput }).flags
        : input;

      // Build dependency graph
      const graph = buildDependencyGraph(ctx.cwd);

      // Find circular dependencies
      const cycles = findCircularDependencies(graph);

      // Output results
      outputCycles(cycles, flags, ui);

      return cycles.length > 0
        ? { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Circular dependencies found', hint: 'Review the dependency cycles, then rerun `kb quality cycles list`.', diagnostics: cycles.map((cycle) => ({ code: 'KB_QUALITY_DEPENDENCY_CYCLE', severity: 'error', message: cycle.join(' -> ') })) } }
        : { cycles };
    },
  },
});

/**
 * Output circular dependencies
 */
function outputCycles(cycles: string[][], flags: Record<string, unknown>, ui: PluginCommandContextV3['ui']) {
  if (flags.json) {
    return;
  }

  if (cycles.length === 0) {
    ui?.success?.('No circular dependencies found', {
      title: '✅ Circular Dependencies Check',
      sections: [
        {
          header: 'Result',
          items: ['✅ No circular dependencies detected'],
        },
      ],
    });
    return;
  }

  // Build sections
  const sections: Array<{ header: string; items: string[] }> = [];

  // Summary
  sections.push({
    header: 'Summary',
    items: [
      `⚠️ Found ${cycles.length} circular dependency chain(s)`,
      'These must be broken to enable clean builds',
    ],
  });

  // Show each cycle
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    if (!cycle) {continue;}
    const cycleItems: string[] = [];

    for (let j = 0; j < cycle.length; j++) {
      const pkg = cycle[j];
      if (j === cycle.length - 1) {
        cycleItems.push(`  ${j + 1}. ${pkg}`);
        const firstPkg = cycle[0];
        cycleItems.push(`  ${j + 2}. ${firstPkg ?? '?'} ⬅ circular!`);
      } else {
        cycleItems.push(`  ${j + 1}. ${pkg}`);
      }
    }

    sections.push({
      header: `Cycle ${i + 1} (${cycle.length} packages)`,
      items: cycleItems,
    });
  }

  // Recommendations
  sections.push({
    header: 'Recommendations',
    items: [
      '1. Extract shared code into a new package',
      '2. Move one dependency to devDependencies',
      '3. Refactor to remove bidirectional dependencies',
      '4. Use dependency injection patterns',
    ],
  });

}
