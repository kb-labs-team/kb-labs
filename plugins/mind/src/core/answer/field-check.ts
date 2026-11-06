/**
 * Field-checker — an anti-hallucination signal ported from the legacy engine.
 *
 * An LLM answer that cites code should only name symbols that actually appear
 * in the retrieved sources. We extract code-like symbols from the answer
 * (backtick spans, camelCase/dotted/underscored identifiers, file names) and
 * check each against the retrieved chunks (text + path). The grounded fraction
 * folds into the confidence stack, and any ungrounded terms are surfaced as a
 * warning — a cheap, deterministic guard against fabricated APIs.
 */

import type { AgentWarning } from '../../contracts/index.js';
import type { RankedChunk } from '../retrieval/retrieve';

/** Heuristic: does this token look like a code symbol worth grounding? */
function isCodeSymbol(t: string): boolean {
  if (t.length < 3 || t.length > 80) {
    return false;
  }
  if (/\.(ts|tsx|js|jsx|json|md|go|py|rs)$/.test(t)) {
    return true; // file name
  }
  if (t.includes('.') && /[a-zA-Z]/.test(t)) {
    return true; // dotted member access (vectorStore.search, config.loader)
  }
  if (/_/.test(t) && /[a-zA-Z]/.test(t)) {
    return true; // snake_case / CONST_CASE
  }
  if (/[a-z][A-Z]/.test(t)) {
    return true; // camelCase / PascalCase transition (assemblePlatform, EventBus)
  }
  return false;
}

/** Extract code-like symbols from an answer (deduped, order-preserving). */
export function extractSymbols(answer: string): string[] {
  const out = new Set<string>();
  // Backtick spans are the strongest signal — the model is quoting code.
  for (const m of answer.matchAll(/`([^`\n]{2,80})`/g)) {
    for (const tok of m[1]!.trim().split(/[\s(),;:[\]{}'"]+/)) {
      if (isCodeSymbol(tok)) {
        out.add(tok);
      }
    }
  }
  // Bare identifiers in prose (camelCase/dotted/underscored/hyphenated/file names).
  for (const m of answer.matchAll(/[A-Za-z_$][A-Za-z0-9_$-]*(?:[./][A-Za-z0-9_$.-]+)*/g)) {
    if (isCodeSymbol(m[0])) {
      out.add(m[0]);
    }
  }
  return [...out];
}

export interface FieldCheckResult {
  /** 0..1 fraction of extracted symbols grounded in the sources. */
  rate: number;
  /** Symbols not found in any retrieved chunk. */
  ungrounded: string[];
  /** Number of symbols checked (0 → nothing to verify, rate defaults to 1). */
  checked: number;
}

/** Check that symbols named in the answer appear in the retrieved sources. */
export function checkFields(answer: string, ranked: RankedChunk[]): FieldCheckResult {
  const symbols = extractSymbols(answer);
  if (symbols.length === 0) {
    return { rate: 1, ungrounded: [], checked: 0 };
  }
  const corpus = ranked.map((r) => `${r.chunk.path}\n${r.chunk.text}`).join('\n').toLowerCase();
  const grounded = (sym: string): boolean => {
    const s = sym.toLowerCase();
    if (corpus.includes(s)) {
      return true;
    }
    // Dotted member (a.b.c): accept if the head object is present in sources.
    const head = s.split('.')[0]!;
    return head.length >= 3 && corpus.includes(head);
  };
  const ungrounded = symbols.filter((s) => !grounded(s));
  return { rate: (symbols.length - ungrounded.length) / symbols.length, ungrounded, checked: symbols.length };
}

/**
 * Fold a field-check into the confidence stack: ungrounded terms scale
 * confidence down (never below 0) and surface as warnings. Returns the adjusted
 * confidence + the (possibly extended) warning list. Pure — no side effects.
 */
export function applyFieldCheck(
  answer: string,
  ranked: RankedChunk[],
  confidence: number,
  warnings: AgentWarning[],
  floor: number,
): { confidence: number; warnings: AgentWarning[] } {
  const fc = checkFields(answer, ranked);
  if (fc.checked === 0 || fc.rate === 1) {
    return { confidence, warnings };
  }
  const adjusted = Math.max(0, confidence * (0.5 + 0.5 * fc.rate));
  const next = [...warnings];
  if (fc.ungrounded.length > 0) {
    next.push({
      code: 'UNGROUNDED_TERMS',
      message: `Answer mentions ${fc.ungrounded.length} term(s) not found in sources: ${fc.ungrounded.slice(0, 5).join(', ')}`,
      details: { ungrounded: fc.ungrounded, rate: Math.round(fc.rate * 1000) / 1000 },
    });
  }
  if (adjusted < floor && !next.some((w) => w.code === 'LOW_CONFIDENCE')) {
    next.push({
      code: 'LOW_CONFIDENCE',
      message: `Confidence ${adjusted.toFixed(2)} is below the floor ${floor.toFixed(2)}; the answer may be unreliable.`,
    });
  }
  return { confidence: adjusted, warnings: next };
}
