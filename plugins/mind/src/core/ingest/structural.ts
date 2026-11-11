/**
 * Structure-aware chunking for code (AST-lite).
 *
 * Splits a source file at top-level declaration boundaries (functions, classes,
 * interfaces, etc.) so chunks align with logical units instead of arbitrary
 * windows. Oversized blocks fall back to the sliding window. This is a
 * dependency-free approximation of AST chunking; a tree-sitter backend can
 * replace it later behind the same `chunkFile` entry without touching callers.
 */

import type { Chunk } from '../types';
import { chunkId, kindFromPath } from '../types';
import { slidingWindowChunks, type ChunkOptions } from './chunk';

// Declaration keywords and leading modifiers. We detect boundaries by scanning
// the line's leading words (linear) rather than a multi-optional-group regex —
// the latter is a polynomial-ReDoS shape on attacker-controlled file content.
const DECL_KEYWORDS = new Set([
  'function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var',
  'namespace', 'module', 'def', 'func', 'fn', 'impl', 'struct', 'trait',
  'public', 'private',
]);
const MODIFIERS = new Set([
  'export', 'default', 'declare', 'public', 'private', 'protected',
  'static', 'abstract', 'async',
]);

/** A top-level (unindented) line whose leading modifiers lead to a declaration. */
function isBoundaryLine(line: string): boolean {
  if (line.length === 0 || line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) {
    return false; // indented → not top-level
  }
  for (const word of line.split(/\s+/)) {
    if (DECL_KEYWORDS.has(word)) {
      return true;
    }
    if (!MODIFIERS.has(word)) {
      return false; // first non-modifier, non-keyword word → not a declaration
    }
  }
  return false;
}

function approxTokens(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

export function structuralChunks(path: string, content: string, opts: ChunkOptions): Chunk[] {
  const lines = content.split('\n');
  const kind = kindFromPath(path);

  // Find top-level boundary line indices (indentation 0, declaration-like).
  const boundaries: number[] = [];
  lines.forEach((line, i) => {
    if (isBoundaryLine(line)) {
      boundaries.push(i);
    }
  });

  if (boundaries.length === 0) {
    return slidingWindowChunks(path, content, opts);
  }

  // Block start indices: file start + each boundary (deduped, sorted).
  const starts = [...new Set([0, ...boundaries])].sort((a, b) => a - b);
  const chunks: Chunk[] = [];

  for (let b = 0; b < starts.length; b++) {
    const from = starts[b]!;
    const to = b + 1 < starts.length ? starts[b + 1]! : lines.length; // exclusive
    const blockLines = lines.slice(from, to);
    const blockText = blockLines.join('\n');
    if (blockText.trim() === '') {
      continue;
    }

    if (approxTokens(blockText) > opts.maxTokens) {
      // Oversized declaration: window it, offsetting line numbers to the block.
      for (const sub of slidingWindowChunks(path, blockText, opts)) {
        const startLine = from + sub.startLine; // sub is 1-based within block
        const endLine = from + sub.endLine;
        chunks.push({ id: chunkId(path, startLine, endLine), path, startLine, endLine, text: sub.text, kind });
      }
    } else {
      const startLine = from + 1;
      const endLine = to;
      chunks.push({ id: chunkId(path, startLine, endLine), path, startLine, endLine, text: blockText, kind });
    }
  }

  return chunks;
}

/** Dispatch: structure-aware for code when enabled, else sliding window. */
export function chunkFile(path: string, content: string, opts: ChunkOptions, ast: boolean): Chunk[] {
  if (ast && kindFromPath(path) === 'code') {
    return structuralChunks(path, content, opts);
  }
  return slidingWindowChunks(path, content, opts);
}
