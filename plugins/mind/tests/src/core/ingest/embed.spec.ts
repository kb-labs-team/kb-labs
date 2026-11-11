import { describe, it, expect } from 'vitest';
import { embedChunks } from '../../../../src/core/ingest/embed';
import type { Chunk } from '../../../../src/core/types';
import type { IEmbeddings } from '../../../../src/core/services';

/** Records the texts passed to each embedBatch call. */
class RecordingEmbedder implements IEmbeddings {
  readonly dimensions = 8;
  readonly batches: string[][] = [];
  async embed(text: string): Promise<number[]> {
    return [text.length];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.batches.push(texts);
    return texts.map((t) => [t.length]);
  }
  async getDimensions(): Promise<number> {
    return this.dimensions;
  }
}

const chunk = (id: string, text: string): Chunk => ({ id, path: `${id}.ts`, startLine: 1, endLine: 1, text, kind: 'code' });

describe('embedChunks — batching bounded by count + token budget', () => {
  it('caps a batch at 96 chunks for small inputs', async () => {
    const emb = new RecordingEmbedder();
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(`c${i}`, 'tiny'));
    await embedChunks(chunks, emb);
    expect(Math.max(...emb.batches.map((b) => b.length))).toBeLessThanOrEqual(96);
    expect(emb.batches.flat().length).toBe(200);
  });

  it('splits by token budget when inputs are large (never one oversized request)', async () => {
    const emb = new RecordingEmbedder();
    // 20 chunks × ~12k chars ≈ 3k tokens each → 60k tokens; must split so no
    // batch exceeds the ~200k-token (≈800k-char) budget, and definitely never
    // the provider's 300k limit.
    const big = 'x'.repeat(12_000);
    const chunks = Array.from({ length: 120 }, (_, i) => chunk(`b${i}`, big));
    await embedChunks(chunks, emb);
    const maxBatchChars = Math.max(...emb.batches.map((b) => b.reduce((s, t) => s + t.length, 0)));
    expect(maxBatchChars).toBeLessThanOrEqual(200_000 * 4); // budget in chars
  });

  it('truncates a single oversized input to the per-input char cap', async () => {
    const emb = new RecordingEmbedder();
    const huge = 'y'.repeat(50_000); // ~> 8192 tokens; provider would reject
    const [rec] = await embedChunks([chunk('huge', huge)], emb);
    expect(emb.batches[0]![0]!.length).toBeLessThanOrEqual(12_000); // embedded text truncated
    // ...but the full original text is preserved in metadata.
    expect((rec!.metadata as { text: string }).text.length).toBe(50_000);
  });
});
