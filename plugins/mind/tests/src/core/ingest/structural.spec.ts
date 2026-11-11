import { describe, it, expect } from 'vitest';
import { structuralChunks, chunkFile } from '../../../../src/core/ingest/structural';

const opts = { maxTokens: 400, overlapTokens: 50 };

describe('structuralChunks', () => {
  it('splits a code file at top-level declaration boundaries', () => {
    const code = [
      'import { x } from "y";',
      '',
      'export function login() {',
      '  return authenticate();',
      '}',
      '',
      'export class Cart {',
      '  add(item) {}',
      '}',
    ].join('\n');

    const chunks = structuralChunks('a.ts', code, opts);
    // One block for the import preamble + login, one for the class.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const loginChunk = chunks.find((c) => c.text.includes('function login'));
    const cartChunk = chunks.find((c) => c.text.includes('class Cart'));
    expect(loginChunk).toBeDefined();
    expect(cartChunk).toBeDefined();
    // The class declaration should not be merged into the login chunk.
    expect(loginChunk?.text.includes('class Cart')).toBe(false);
  });

  it('falls back to sliding window when there are no boundaries', () => {
    const prose = Array.from({ length: 40 }, (_, i) => `plain line ${i} alpha beta`).join('\n');
    const chunks = structuralChunks('a.ts', prose, { maxTokens: 20, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunkFile uses structural only for code when ast=true', () => {
    const code = 'export function f() {}\nexport function g() {}';
    const ast = chunkFile('a.ts', code, opts, true);
    const sliding = chunkFile('a.ts', code, opts, false);
    expect(ast.length).toBeGreaterThanOrEqual(2);
    // Sliding window keeps the short file as one chunk.
    expect(sliding.length).toBe(1);
  });

  it('chunkFile never uses structural for docs', () => {
    const md = '# Title\n\nfunction-looking text but markdown\n';
    const chunks = chunkFile('readme.md', md, opts, true);
    expect(chunks[0]?.kind).toBe('doc');
  });
});
