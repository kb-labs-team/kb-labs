/**
 * SearchSignalMiddleware — search quality tracking and early conclusion.
 *
 * Feature-flagged: enabled when FeatureFlags.searchSignal is true.
 */

import type { FeatureFlags } from '../../../contracts/index.js';
import type { ToolExecCtx, ToolOutput } from '../../../sdk/index.js';

const SEARCH_TOOL_NAMES = new Set(['grep_search', 'glob_search', 'find_definition', 'fs_read']);

export interface SearchSignalMwState {
  searchSignalHits: number;
  lastSignalIteration: number;
  noResultStreak: number;
}

export interface SearchSignalCallbacks {
  onSignalHit?: (toolName: string, iteration: number) => void;
  onNoResultStreak?: (streak: number, iteration: number) => void;
}

export class SearchSignalMiddleware {
  readonly name = 'search-signal';
  readonly order = 60;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 2000 };

  private readonly callbacks: SearchSignalCallbacks;
  private _hits = 0;
  private _lastSignalIteration = -1;
  private _noResultStreak = 0;
  private _featureFlags?: FeatureFlags;

  constructor(callbacks: SearchSignalCallbacks = {}) {
    this.callbacks = callbacks;
  }

  enabled(): boolean {
    return this._featureFlags?.searchSignal ?? false;
  }

  withFeatureFlags(flags: FeatureFlags): this {
    this._featureFlags = flags;
    return this;
  }

  get state(): SearchSignalMwState {
    return {
      searchSignalHits: this._hits,
      lastSignalIteration: this._lastSignalIteration,
      noResultStreak: this._noResultStreak,
    };
  }

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    if (!SEARCH_TOOL_NAMES.has(ctx.toolName)) {return;}

    const hasResults = result.output && result.output.length > 50 && result.success;

    if (hasResults) {
      this._hits++;
      this._lastSignalIteration = ctx.iteration;
      this._noResultStreak = 0;
      this.callbacks.onSignalHit?.(ctx.toolName, ctx.iteration);
    } else {
      this._noResultStreak++;
      this.callbacks.onNoResultStreak?.(this._noResultStreak, ctx.iteration);
    }

    ctx.run.meta.set('search', 'signalHits', this._hits);
    ctx.run.meta.set('search', 'lastSignalIteration', this._lastSignalIteration);
  }

  onStop(): void {
    this.reset();
  }

  reset(): void {
    this._hits = 0;
    this._lastSignalIteration = -1;
    this._noResultStreak = 0;
  }
}
