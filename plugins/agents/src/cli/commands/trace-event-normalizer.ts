import type { DetailedTraceEntry } from '../../contracts/index.js';

export type NormalizedTraceEvent = {
  raw: DetailedTraceEntry;
  type: string;
  data: Record<string, unknown>;
  iteration: number;
};

export function normalizeTraceEvents(events: DetailedTraceEntry[]): NormalizedTraceEvent[] {
  const out: NormalizedTraceEvent[] = [];
  let currentIteration = 0;

  for (const raw of events) {
    const type = String(raw.type ?? '');
    const data = getEventData(raw);

    const explicitIteration = asNumber(raw.iteration) ?? asNumber(data.iteration);
    if (type === 'iteration:start') {
      currentIteration = explicitIteration ?? Math.max(1, currentIteration + 1);
    }

    const iteration = explicitIteration ?? currentIteration;
    out.push({ raw, type, data, iteration });
  }

  return out;
}

export function getEventData(event: DetailedTraceEntry): Record<string, unknown> {
  const data = (event as unknown as Record<string, unknown>).data;
  if (data && typeof data === 'object') {
    return data as Record<string, unknown>;
  }
  return {};
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}
