import { describe, it, expect } from 'vitest';
import { resolveMindConfig } from '@kb-labs/mind/contracts';
import { createMind } from '../../../src/core/index.js';
import type { IngestProgress } from '../../../src/core/index.js';
import { makeTestWorkspace } from '../../../src/core/testing';

describe('ingest — staged progress events', () => {
  it('emits ordered stages with an embedding counter on a fresh index', async () => {
    const ws = makeTestWorkspace({
      'src/a.ts': 'export function alpha() { return 1 }',
      'src/b.ts': 'export function beta() { return 2 }',
    });
    const mind = createMind(ws.services, resolveMindConfig({}), { cwd: ws.cwd });

    const events: IngestProgress[] = [];
    await mind.index({ indexId: 'code', scope: 'src/' }, (e) => events.push(e));

    const stages = events.map((e) => e.stage);
    // Order: discover → delta → chunk → embed(s) → upsert → save.
    expect(stages[0]).toBe('discover');
    expect(stages[1]).toBe('delta');
    expect(stages).toContain('chunk');
    expect(stages).toContain('embed');
    expect(stages).toContain('upsert');
    expect(stages[stages.length - 1]).toBe('save');

    const discover = events.find((e) => e.stage === 'discover');
    expect(discover && 'files' in discover && discover.files).toBeGreaterThan(0);

    // The embed event(s) carry a monotonic done/total counter ending at total.
    const embeds = events.filter((e): e is Extract<IngestProgress, { stage: 'embed' }> => e.stage === 'embed');
    expect(embeds.length).toBeGreaterThan(0);
    const last = embeds[embeds.length - 1]!;
    expect(last.done).toBe(last.total);
    expect(last.total).toBeGreaterThan(0);
  });

  it('re-index with no changes reports an empty delta and embeds nothing', async () => {
    const ws = makeTestWorkspace({ 'src/a.ts': 'export const x = 1' });
    const mind = createMind(ws.services, resolveMindConfig({}), { cwd: ws.cwd });
    await mind.index({ indexId: 'code', scope: 'src/' });

    const events: IngestProgress[] = [];
    await mind.index({ indexId: 'code', scope: 'src/' }, (e) => events.push(e));

    const delta = events.find((e) => e.stage === 'delta');
    expect(delta).toMatchObject({ stage: 'delta', toIndex: 0 });
    expect(events.some((e) => e.stage === 'embed')).toBe(false);
  });
});
