import { describe, it, expect } from 'vitest';
import { AgentResponseSchema, MindConfigSchema, resolveMindConfig, SearchRequestSchema } from '../../src/contracts/index.js';

/**
 * A representative agent response (lean shape) — snapshot guard against drift.
 * Pointers (file+lines), provenance (matchedBy), freshness (stale), trust
 * (confidence/abstained), telemetry in meta. No legacy fields.
 */
const AGENT_RESPONSE = {
  answer: 'The auth flow lives in src/auth.ts.',
  confidence: 0.81,
  abstained: false,
  sources: [
    { file: 'src/auth.ts', lines: [10, 42], kind: 'code', matchedBy: 'both', stale: false, snippet: 'export function login()' },
    { file: 'docs/auth.md', lines: [1, 20], kind: 'doc', matchedBy: 'semantic', stale: true },
  ],
  warnings: [],
  meta: { requestId: 'req-123', mode: 'auto', timingMs: 2341, indexId: 'code' },
};

describe('agent response contract (lean)', () => {
  it('accepts the lean agent-response shape', () => {
    const parsed = AgentResponseSchema.parse(AGENT_RESPONSE);
    expect(parsed.abstained).toBe(false);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0]?.matchedBy).toBe('both');
    expect(parsed.sources[1]?.stale).toBe(true);
  });

  it('round-trips without mutating the payload', () => {
    expect(AgentResponseSchema.parse(AGENT_RESPONSE)).toEqual(AGENT_RESPONSE);
  });

  it('preserves unknown meta keys (open shape)', () => {
    const parsed = AgentResponseSchema.parse({
      ...AGENT_RESPONSE,
      meta: { ...AGENT_RESPONSE.meta, custom: 'x' },
    });
    expect((parsed.meta as Record<string, unknown>).custom).toBe('x');
  });

  it('requires matchedBy + stale on every source (no legacy shape)', () => {
    expect(() =>
      AgentResponseSchema.parse({
        ...AGENT_RESPONSE,
        sources: [{ file: 'x', lines: [1, 1], kind: 'code' }], // missing matchedBy/stale
      }),
    ).toThrow();
  });
});

describe('config resolution', () => {
  it('fills defaults from an empty config', () => {
    const cfg = resolveMindConfig(undefined);
    expect(cfg.defaultIndex).toBe('default');
    expect(cfg.modes.instant.useLLM).toBe(false);
    expect(cfg.modes.thinking.maxSubqueries).toBe(5);
    expect(cfg.chunk.maxTokens).toBe(400);
  });

  it('honors overrides', () => {
    const cfg = resolveMindConfig({ defaultIndex: 'code', retrieval: { limit: 25 } });
    expect(cfg.defaultIndex).toBe('code');
    expect(cfg.retrieval.limit).toBe(25);
    expect(cfg.retrieval.rrfK).toBe(60); // default preserved
  });

  it('validates the full config schema', () => {
    expect(() => MindConfigSchema.parse({ retrieval: { limit: -1 } })).toThrow();
  });
});

describe('search request', () => {
  it('requires non-empty text', () => {
    expect(() => SearchRequestSchema.parse({ text: '' })).toThrow();
    expect(SearchRequestSchema.parse({ text: 'hello' }).text).toBe('hello');
  });
});
