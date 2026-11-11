import { describe, it, expect } from 'vitest';
import { Tracer, type Stage } from '../../../src/core/pipeline';
import type { MindServices } from '../../../src/core/services';

// Pipeline stages are pure functions of (input, services); we don't need real
// platform adapters to test the primitive, so an empty services stub suffices.
const services = {} as MindServices;

describe('Tracer', () => {
  it('runs a stage and records its trace', async () => {
    let tick = 0;
    const clock = () => (tick += 5); // deterministic 5ms steps
    const tracer = new Tracer('req-1', 'auto', clock);

    const double: Stage<number[], number[]> = async (xs) => xs.map((x) => x * 2);
    const out = await tracer.run('double', [1, 2, 3], services, double);

    expect(out).toEqual([2, 4, 6]);
    const trace = tracer.build(100);
    expect(trace.requestId).toBe('req-1');
    expect(trace.mode).toBe('auto');
    expect(trace.stages).toHaveLength(1);
    expect(trace.stages[0]).toMatchObject({ stage: 'double', durationMs: 5, outputCount: 3 });
  });

  it('threads multiple stages and preserves order', async () => {
    const tracer = new Tracer('req-2', 'instant', () => 0);
    const inc: Stage<number, number> = async (n) => n + 1;
    const sq: Stage<number, number> = async (n) => n * n;

    const a = await tracer.run('inc', 1, services, inc); // 2
    const b = await tracer.run('sq', a, services, sq); // 4

    expect(b).toBe(4);
    expect(tracer.build(0).stages.map((s) => s.stage)).toEqual(['inc', 'sq']);
  });

  it('omits outputCount for non-array stage output', async () => {
    const tracer = new Tracer('req-3', 'instant', () => 0);
    await tracer.run('scalar', 0, services, async () => 42);
    expect(tracer.build(0).stages[0]?.outputCount).toBeUndefined();
  });
});
