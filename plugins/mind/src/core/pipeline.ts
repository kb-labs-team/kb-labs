/**
 * Pipeline primitive.
 *
 * Every stage is a pure function `(input, services) => output`. A `Tracer`
 * times each stage and collects `StageTrace` entries so the full query flow
 * (retrieve → fuse → rerank → verify → compress → synthesize) is observable.
 * Modes (instant/auto/thinking) are just configs deciding which stages run —
 * never separate code paths.
 */

import type { StageTrace, Trace } from '../contracts/index.js';
import type { MindServices } from './services';

export type Stage<I, O> = (input: I, services: MindServices) => Promise<O>;

/** Monotonic clock; injectable so tests stay deterministic. */
export type Clock = () => number;

const defaultClock: Clock = () => Date.now();

/**
 * Collects per-stage traces for one request. `run` times a stage and records
 * its duration + output size.
 */
export class Tracer {
  private readonly stages: StageTrace[] = [];

  constructor(
    private readonly requestId: string,
    private readonly mode: string,
    private readonly clock: Clock = defaultClock,
  ) {}

  async run<I, O>(stage: string, input: I, services: MindServices, fn: Stage<I, O>): Promise<O> {
    const start = this.clock();
    const output = await fn(input, services);
    this.stages.push({
      stage,
      durationMs: this.clock() - start,
      outputCount: Array.isArray(output) ? output.length : undefined,
    });
    return output;
  }

  /** Record a stage trace manually (for stages not wrapped by `run`). */
  record(trace: StageTrace): void {
    this.stages.push(trace);
  }

  build(totalMs: number): Trace {
    return {
      requestId: this.requestId,
      mode: this.mode,
      totalMs,
      stages: [...this.stages],
    };
  }
}
