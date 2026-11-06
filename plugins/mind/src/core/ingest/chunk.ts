/**
 * Sliding-window chunker (Phase 2 baseline; AST chunking is layered in Phase 3).
 *
 * Splits a file into line-aligned chunks of roughly `maxTokens` tokens with
 * `overlapTokens` of overlap. Token count is approximated by whitespace words —
 * good enough for windowing; real tokenization is not needed here.
 */

import type { Chunk } from '../types';
import { chunkId, kindFromPath } from '../types';

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

function approxTokens(line: string): number {
  const t = line.trim();
  if (t === '') {
    return 0;
  }
  return t.split(/\s+/).length;
}

export function slidingWindowChunks(path: string, content: string, opts: ChunkOptions): Chunk[] {
  const lines = content.split('\n');
  const kind = kindFromPath(path);
  const chunks: Chunk[] = [];

  const maxTokens = Math.max(1, opts.maxTokens);
  const overlapTokens = Math.max(0, Math.min(opts.overlapTokens, maxTokens - 1));

  let startIdx = 0;
  while (startIdx < lines.length) {
    let tokens = 0;
    let endIdx = startIdx;
    while (endIdx < lines.length && tokens < maxTokens) {
      tokens += approxTokens(lines[endIdx] ?? '');
      endIdx++;
    }

    const startLine = startIdx + 1; // 1-based, inclusive
    const endLine = endIdx; // 1-based, inclusive
    const text = lines.slice(startIdx, endIdx).join('\n');

    if (text.trim() !== '') {
      chunks.push({ id: chunkId(path, startLine, endLine), path, startLine, endLine, text, kind });
    }

    if (endIdx >= lines.length) {
      break;
    }

    // Step back by roughly `overlapTokens` worth of lines for overlap.
    let overlap = 0;
    let stepBack = 0;
    let i = endIdx - 1;
    while (i > startIdx && overlap < overlapTokens) {
      overlap += approxTokens(lines[i] ?? '');
      stepBack++;
      i--;
    }
    startIdx = Math.max(startIdx + 1, endIdx - stepBack);
  }

  return chunks;
}
