/**
 * Task-orientation map. No hardcoded role/name heuristics: relevance + ranking
 * come from retrieval, the orientation ("where to start / how involved") comes
 * from the model, and structure (`spread`) is derived from the actual paths.
 */

import type { ExploreEntry } from '../../contracts/index.js';
import type { ILLM } from '../services';
import type { RankedChunk } from '../retrieval/retrieve';
import { snippetFrom } from './synthesize';

/** Ranked chunks → entries deduped by file (best rank kept). `why` = matched line. */
export function toExploreEntries(ranked: RankedChunk[], staleByFile: Map<string, boolean>): ExploreEntry[] {
  const seen = new Set<string>();
  const out: ExploreEntry[] = [];
  for (const r of ranked) {
    if (seen.has(r.chunk.path)) {
      continue;
    }
    seen.add(r.chunk.path);
    const line = snippetFrom(r.chunk.text, 'line');
    out.push({
      file: r.chunk.path,
      lines: [r.chunk.startLine, r.chunk.endLine] as [number, number],
      why: line && line.length > 0 ? line : `${r.chunk.kind} file`,
      matchedBy: r.matchedBy,
      stale: staleByFile.get(r.chunk.path) ?? false,
    });
  }
  return out;
}

/** Distinct directories the files span — a structural "how spread out" hint. */
export function spreadOf(files: string[]): number {
  return new Set(
    files.map((f) => {
      const i = f.lastIndexOf('/');
      return i < 0 ? '.' : f.slice(0, i);
    }),
  ).size;
}

/**
 * Model-synthesized orientation grounded in the retrieved files. Empty string
 * when no LLM is available (e.g. instant mode) — the file list still stands.
 */
export async function orientationSummary(
  task: string,
  entries: ExploreEntry[],
  llm: ILLM,
  useLLM: boolean,
): Promise<string> {
  if (!useLLM || entries.length === 0) {
    return '';
  }
  const list = entries.map((e, i) => `[${i + 1}] ${e.file}:${e.lines[0]}-${e.lines[1]} — ${e.why}`).join('\n');
  const prompt =
    `A developer must approach the task below in an unfamiliar codebase. Using ONLY the ` +
    `relevant files listed, briefly explain WHERE to start, the KEY files and their role, ` +
    `and HOW involved the task looks. Be concise; cite files by path.\n\n` +
    `Task: ${task}\n\nRelevant files:\n${list}`;
  try {
    const { content } = await llm.complete(prompt, { temperature: 0.2, maxTokens: 400 });
    return (content ?? '').trim();
  } catch {
    return '';
  }
}
