/**
 * FactSheet — structured working memory for agent runs.
 *
 * Pure data structure: no middleware coupling, no LLM calls, no I/O.
 * FactSheetMiddleware wires it into the agent lifecycle.
 *
 * Features:
 *   - Categorized facts with priority-based rendering
 *   - Deduplication via word overlap (60% threshold)
 *   - Token budget + entry count eviction (never evicts corrections/blockers)
 *   - Compact markdown render for system prompt injection
 *   - Serializable (toJSON / fromJSON) for cross-session persistence
 */

import type { FactCategory, FactSheetEntry } from '../../contracts/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface FactSheetConfig {
  /** Max estimated tokens for rendered output (~4 chars/token). Default: 5000 */
  maxTokens?: number;
  /** Max number of facts before eviction. Default: 60 */
  maxEntries?: number;
  /** Min confidence for auto-extracted facts. Default: 0.5 */
  minConfidence?: number;
}

const DEFAULTS = {
  maxTokens: 5_000,
  maxEntries: 60,
  minConfidence: 0.5,
} as const;

// ─── Priority order (lower index = higher priority) ──────────────────────────

const CATEGORY_PRIORITY: FactCategory[] = [
  'correction',
  'blocker',
  'decision',
  'finding',
  'file_content',
  'architecture',
  'tool_result',
  'environment',
];

const CATEGORY_HEADERS: Record<FactCategory, string> = {
  correction: 'Corrections',
  blocker: 'Blockers',
  decision: 'Decisions',
  finding: 'Findings',
  file_content: 'Files Read',
  architecture: 'Architecture',
  tool_result: 'Tool Results',
  environment: 'Environment',
};

/** Categories that are never evicted */
const PROTECTED: ReadonlySet<FactCategory> = new Set(['correction', 'blocker']);

/** Categories where dedup uses file path instead of word overlap */
const PATH_DEDUP: ReadonlySet<FactCategory> = new Set(['file_content']);

const DEDUP_THRESHOLD = 0.6;

// ─── FactSheet ───────────────────────────────────────────────────────────────

export class FactSheet {
  private facts = new Map<string, FactSheetEntry>();
  private nextId = 1;
  private readonly maxTokens: number;
  private readonly maxEntries: number;
  readonly minConfidence: number;

  constructor(config: FactSheetConfig = {}) {
    this.maxTokens = config.maxTokens ?? DEFAULTS.maxTokens;
    this.maxEntries = config.maxEntries ?? DEFAULTS.maxEntries;
    this.minConfidence = config.minConfidence ?? DEFAULTS.minConfidence;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Add or merge a fact. Returns the entry and whether it was merged.
   * Skips facts below minConfidence.
   */
  add(params: {
    category: FactCategory;
    fact: string;
    confidence: number;
    source: string;
    iteration: number;
    supersedes?: string;
  }): { entry: FactSheetEntry; merged: boolean } | null {
    if (params.confidence < this.minConfidence) {return null;}

    // Supersede: remove the old fact
    if (params.supersedes) {this.facts.delete(params.supersedes);}

    // Dedup: merge if similar fact exists
    const similar = this.findSimilar(params.category, params.fact);
    if (similar) {
      similar.fact = params.fact.length > similar.fact.length ? params.fact : similar.fact;
      similar.confidence = Math.min(1.0, Math.max(similar.confidence, params.confidence));
      similar.confirmations += 1;
      similar.iteration = params.iteration;
      similar.updatedAt = new Date().toISOString();
      similar.source = params.source;
      this.enforceLimit();
      return { entry: similar, merged: true };
    }

    // New fact
    const id = `fact_${this.nextId++}`;
    const entry: FactSheetEntry = {
      id,
      iteration: params.iteration,
      category: params.category,
      fact: params.fact,
      confidence: params.confidence,
      source: params.source,
      updatedAt: new Date().toISOString(),
      confirmations: 1,
      supersedes: params.supersedes,
    };

    this.facts.set(id, entry);
    this.enforceLimit();
    return { entry, merged: false };
  }

  remove(id: string): boolean {
    return this.facts.delete(id);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  getAll(): FactSheetEntry[] {
    return [...this.facts.values()].sort((a, b) => {
      const pa = CATEGORY_PRIORITY.indexOf(a.category);
      const pb = CATEGORY_PRIORITY.indexOf(b.category);
      if (pa !== pb) {return pa - pb;}
      return b.iteration - a.iteration;
    });
  }

  get size(): number {
    return this.facts.size;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  /**
   * Compact markdown for system prompt injection.
   * Returns empty string if no facts.
   */
  render(): string {
    if (this.facts.size === 0) {return '';}

    const sorted = this.getAll();
    const lines: string[] = [];
    let currentCategory: FactCategory | null = null;

    for (const fact of sorted) {
      if (fact.category !== currentCategory) {
        currentCategory = fact.category;
        lines.push(`\n## ${CATEGORY_HEADERS[currentCategory] ?? currentCategory}`);
      }
      const conf = fact.confidence >= 0.8 ? '' : ` [conf:${fact.confidence.toFixed(1)}]`;
      lines.push(`- ${fact.fact}${conf}`);
    }

    return lines.join('\n');
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats(): { totalFacts: number; estimatedTokens: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const f of this.facts.values()) {
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }
    return {
      totalFacts: this.facts.size,
      estimatedTokens: Math.ceil(this.render().length / 4),
      byCategory,
    };
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  toJSON(): { facts: Array<[string, FactSheetEntry]>; nextId: number } {
    return { facts: [...this.facts.entries()], nextId: this.nextId };
  }

  static fromJSON(
    data: { facts: Array<[string, FactSheetEntry]>; nextId: number },
    config?: FactSheetConfig,
  ): FactSheet {
    const sheet = new FactSheet(config);
    for (const [key, value] of data.facts) {
      sheet.facts.set(key, value);
    }
    sheet.nextId = data.nextId;
    return sheet;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private findSimilar(category: FactCategory, text: string): FactSheetEntry | undefined {
    if (PATH_DEDUP.has(category)) {
      const inputPath = extractFilePath(text);
      if (!inputPath) {return undefined;}
      for (const f of this.facts.values()) {
        if (f.category !== category) {continue;}
        if (extractFilePath(f.fact) === inputPath) {return f;}
      }
      return undefined;
    }

    const inputWords = words(text);
    if (inputWords.size === 0) {return undefined;}

    for (const f of this.facts.values()) {
      if (f.category !== category) {continue;}
      const fw = words(f.fact);
      if (fw.size === 0) {continue;}
      if (overlap(inputWords, fw) >= DEDUP_THRESHOLD) {return f;}
    }
    return undefined;
  }

  private enforceLimit(): void {
    while (this.facts.size > this.maxEntries) {this.evictOne();}

    while (this.facts.size > 0) {
      const tokens = Math.ceil(this.render().length / 4);
      if (tokens <= this.maxTokens) {break;}
      this.evictOne();
    }
  }

  private evictOne(): void {
    let candidate: FactSheetEntry | null = null;

    for (const f of this.facts.values()) {
      if (PROTECTED.has(f.category)) {continue;}
      if (!candidate) { candidate = f; continue; }

      // Lowest confidence → fewest confirmations → oldest iteration
      if (
        f.confidence < candidate.confidence
        || (f.confidence === candidate.confidence && f.confirmations < candidate.confirmations)
        || (f.confidence === candidate.confidence && f.confirmations === candidate.confirmations && f.iteration < candidate.iteration)
      ) {
        candidate = f;
      }
    }

    if (candidate) {this.facts.delete(candidate.id);}
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function extractFilePath(text: string): string | null {
  return text.match(/^Read\s+(\S+)\s*\(/i)?.[1] ?? null;
}

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const w of a) {if (b.has(w)) {count++;}}
  const min = Math.min(a.size, b.size);
  return min === 0 ? 0 : count / min;
}
