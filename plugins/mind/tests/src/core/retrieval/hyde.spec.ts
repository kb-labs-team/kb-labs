import { describe, it, expect } from 'vitest';
import { resolveMindConfig } from '@kb-labs/mind/contracts';
import { createMind } from '../../../../src/core/mind';
import { DeterministicEmbedder, makeTestWorkspace, makeScriptedLLM } from '../../../../src/core/testing';

/**
 * HyDE swaps the text fed to the vector search: the LLM's hypothetical answer
 * instead of the raw query (BM25 still uses the raw query). We assert that
 * wiring directly with a recording embedder — robust to fusion/ranking noise.
 */
class RecordingEmbedder extends DeterministicEmbedder {
  readonly embedded: string[] = [];
  override async embed(text: string): Promise<number[]> {
    this.embedded.push(text);
    return super.embed(text);
  }
}

describe('retrieval — HyDE (hypothetical document embeddings)', () => {
  const files = {
    'src/alpha.ts': 'export function quokka() { return zephyr(qux) }',
    'src/beta.ts': '// obscure unrelated phrasing\nexport const helper = 1',
  };
  const query = 'obscure unrelated phrasing';
  const hypothetical = 'quokka zephyr qux quokka zephyr qux';

  async function searchEmbeds(hyde: boolean): Promise<string[]> {
    const rec = new RecordingEmbedder();
    const ws = makeTestWorkspace(files, { embeddings: rec, llm: makeScriptedLLM(hypothetical) });
    const cfg = resolveMindConfig({ retrieval: { hyde, rerank: false, dedup: false } });
    const mind = createMind(ws.services, cfg, { cwd: ws.cwd });
    await mind.index({ indexId: 'code', scope: 'src/' });
    rec.embedded.length = 0; // drop index-time chunk embeddings; keep only search-time
    await mind.search({ text: query, indexId: 'code' });
    return rec.embedded;
  }

  it('on: feeds the LLM hypothetical (not the bare query) to the vector embedder', async () => {
    const embedded = await searchEmbeds(true);
    expect(embedded.some((t) => t.includes('quokka zephyr qux'))).toBe(true);
  });

  it('off: feeds only the raw query — never the hypothetical', async () => {
    const embedded = await searchEmbeds(false);
    expect(embedded.some((t) => t.includes('quokka zephyr qux'))).toBe(false);
    expect(embedded.some((t) => t.includes(query))).toBe(true);
  });
});
