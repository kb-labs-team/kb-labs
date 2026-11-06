/**
 * Shape ranked chunks into lean wire `SearchResult`s (pointers, not payloads).
 *
 * `snippet` rides only as much text as the caller asked for (`--snippet`):
 * none → nothing; line → the first meaningful line; full → truncated chunk.
 */

import type { SearchResult, SnippetMode } from '../../contracts/index.js';
import type { RankedChunk } from '../retrieval/retrieve';

const MAX_SNIPPET_CHARS = 600;

/** Extract a snippet of the requested verbosity from chunk text. */
export function snippetFrom(text: string, mode: SnippetMode): string | undefined {
  if (mode === 'none') {
    return undefined;
  }
  if (mode === 'full') {
    return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text;
  }
  // 'line' — the first non-trivial line, for an "is this it?" glance.
  const line = text.split('\n').find((l) => l.trim().length > 8)?.trim() ?? text.trim().slice(0, 120);
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export interface ToResultsOptions {
  snippet: SnippetMode;
  /** file → stale (on-disk drift since indexing). */
  staleByFile: Map<string, boolean>;
}

export function toSearchResults(ranked: RankedChunk[], opts: ToResultsOptions): SearchResult[] {
  return ranked.map(({ chunk, matchedBy }) => ({
    file: chunk.path,
    lines: [chunk.startLine, chunk.endLine] as [number, number],
    kind: chunk.kind,
    matchedBy,
    stale: opts.staleByFile.get(chunk.path) ?? false,
    snippet: snippetFrom(chunk.text, opts.snippet),
  }));
}
