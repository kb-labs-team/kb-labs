import { describe, it, expect, beforeEach } from 'vitest';
import { AgentResponseSchema, resolveMindConfig } from '@kb-labs/mind/contracts';
import { createMind, type Mind } from '../../../src/core/index.js';
import { makeTestWorkspace, makeScriptedLLM, type TestServices } from '../../../src/core/testing';

describe('mind.ask — agent answers (frozen agent-response-v1)', () => {
  let services: TestServices;
  let cwd: string;

  beforeEach(async () => {
    const ws = makeTestWorkspace({
      'src/auth.ts': 'export function login(user, password) { return authenticate(user, password); }',
      'src/cart.ts': 'export function addToCart(item) { cart.push(item); }',
    });
    services = ws.services;
    cwd = ws.cwd;
  });

  async function indexed(mind: Mind): Promise<Mind> {
    await mind.index({ indexId: 'code', scope: 'src/' });
    return mind;
  }

  it('returns a contract-valid response in instant mode (no LLM)', async () => {
    const mind = await indexed(createMind(services, resolveMindConfig({}), { cwd, now: () => 1000 }));
    const res = await mind.ask({ text: 'login authenticate user', indexId: 'code', mode: 'instant' });

    expect(() => AgentResponseSchema.parse(res)).not.toThrow();
    expect(res.meta.mode).toBe('instant');
    expect(res.meta.indexId).toBe('code');
    expect(typeof res.abstained).toBe('boolean');
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources[0]?.file).toBe('src/auth.ts');
    expect(res.sources[0]?.matchedBy).toBeDefined();
    expect(res.answer.length).toBeGreaterThan(0);
  });

  it('uses the LLM answer in auto mode when available', async () => {
    const llm = makeScriptedLLM('Login is handled by login() in src/auth.ts.');
    const mind = await indexed(createMind(makeServicesWithLLM(services, llm), resolveMindConfig({}), { cwd, now: () => 1000 }));
    const res = await mind.ask({ text: 'how does login work', indexId: 'code', mode: 'auto' });

    expect(res.answer).toContain('login()');
    expect(res.meta.mode).toBe('auto');
    expect(typeof res.abstained).toBe('boolean');
    expect(res.sources.length).toBeGreaterThan(0);
  });

  it('abstains gracefully on an empty index (low confidence, no sources)', async () => {
    const mind = createMind(services, resolveMindConfig({}), { cwd, now: () => 1000 });
    const res = await mind.ask({ text: 'anything', indexId: 'empty', mode: 'instant' });

    expect(() => AgentResponseSchema.parse(res)).not.toThrow();
    expect(res.sources).toEqual([]);
    expect(res.abstained).toBe(true);
  });

  it('records the query in feedback history', async () => {
    const recorded: Array<[string, number, string]> = [];
    const cache = {
      async zadd(key: string, score: number, member: string) {
        recorded.push([key, score, member]);
      },
      async zrangebyscore() {
        return [];
      },
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    } as unknown as TestServices['cache'];

    const mind = await indexed(
      createMind({ ...services, cache }, resolveMindConfig({}), { cwd, now: () => 4242 }),
    );
    await mind.ask({ text: 'login', indexId: 'code', mode: 'instant' });
    expect(recorded.some(([, , member]) => member === 'login')).toBe(true);
  });
});

// Helper: clone services with a specific LLM.
function makeServicesWithLLM(base: TestServices, llm: TestServices['llm']): TestServices {
  return { ...base, llm } as TestServices;
}
