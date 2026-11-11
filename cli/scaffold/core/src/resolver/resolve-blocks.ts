import type { BlockDefinition } from '@kb-labs/scaffold-contracts';

export interface ResolveResult {
  /** Block ids in topological order (dependencies first). */
  ordered: string[];
  /** Full block definitions in the same order. */
  blocks: BlockDefinition[];
}

/**
 * Resolve a user-selected set of block ids into a topologically sorted list,
 * expanding `requires` and rejecting cycles or `conflicts` violations.
 */
export function resolveBlocks(
  all: BlockDefinition[],
  selected: string[],
): ResolveResult {
  const byId = new Map<string, BlockDefinition>();
  for (const b of all) {byId.set(b.id, b);}

  const missing = selected.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown block(s): ${missing.join(', ')}`);
  }

  // Expand requires (BFS).
  const expanded = new Set<string>();
  const queue = [...selected];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (expanded.has(id)) {continue;}
    expanded.add(id);
    const block = byId.get(id);
    if (!block) {continue;}
    for (const dep of block.requires ?? []) {
      if (!byId.has(dep)) {
        throw new Error(
          `Block "${id}" requires unknown block "${dep}"`,
        );
      }
      if (!expanded.has(dep)) {queue.push(dep);}
    }
  }

  // Conflict check against the final expanded set.
  for (const id of expanded) {
    const block = byId.get(id)!;
    for (const other of block.conflicts ?? []) {
      if (expanded.has(other)) {
        throw new Error(
          `Block "${id}" conflicts with "${other}" — both selected`,
        );
      }
    }
  }

  // Topological sort (Kahn's algorithm).
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();
  for (const id of expanded) {
    inDegree.set(id, 0);
    edges.set(id, new Set());
  }
  for (const id of expanded) {
    const block = byId.get(id)!;
    for (const dep of block.requires ?? []) {
      if (!expanded.has(dep)) {continue;}
      edges.get(dep)!.add(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  const ready: string[] = [];
  for (const [id, deg] of inDegree) {if (deg === 0) {ready.push(id);}}
  ready.sort();

  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const next of edges.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  if (ordered.length !== expanded.size) {
    throw new Error('Cycle detected in block requires graph');
  }

  return { ordered, blocks: ordered.map((id) => byId.get(id)!) };
}
