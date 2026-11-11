/**
 * Embed chunks into vector records via the platform embeddings adapter.
 */

import type { Chunk, ChunkMeta } from '../types';
import type { IEmbeddings, VectorRecord } from '../services';

/** Max chunks per embedding request. */
const MAX_BATCH_CHUNKS = 96;
/** Max approx tokens per request — kept well under provider limits (e.g. OpenAI 300k). */
const MAX_BATCH_TOKENS = 200_000;
/**
 * Hard char cap on a single input. Providers cap inputs at ~8192 tokens; dense
 * markdown/code runs ~2–3 chars/token, so 12k chars stays safely under that.
 * Only pathological chunks (e.g. a doc with one enormous line the chunker
 * couldn't split) hit this; the full text is still kept in metadata.
 */
const MAX_INPUT_CHARS = 12_000;
/** Rough chars→tokens estimate for batch budgeting (avoids a tokenizer dep). */
const CHARS_PER_TOKEN = 4;

const approxTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

function toRecord(chunk: Chunk, vector: number[], text: string): VectorRecord {
  const meta: ChunkMeta = {
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text,
    kind: chunk.kind,
  };
  return { id: chunk.id, vector, metadata: meta };
}

/**
 * Split chunks into request batches bounded by BOTH a chunk count and an approx
 * token budget, so a batch never exceeds the provider's per-request token limit
 * (which count-only batching blows on large files). Oversized single inputs are
 * truncated to the per-input cap.
 */
function planBatches(chunks: Chunk[]): { chunk: Chunk; text: string }[][] {
  const items = chunks.map((c) => ({
    chunk: c,
    text: c.text.length > MAX_INPUT_CHARS ? c.text.slice(0, MAX_INPUT_CHARS) : c.text,
  }));
  const batches: { chunk: Chunk; text: string }[][] = [];
  let cur: { chunk: Chunk; text: string }[] = [];
  let curTokens = 0;
  for (const item of items) {
    const t = approxTokens(item.text);
    if (cur.length > 0 && (cur.length >= MAX_BATCH_CHUNKS || curTokens + t > MAX_BATCH_TOKENS)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(item);
    curTokens += t;
  }
  if (cur.length > 0) {
    batches.push(cur);
  }
  return batches;
}

/**
 * Embed chunks into vector records. Batched by count + token budget so the
 * embedding stage reports progress and never sends an oversized request.
 */
export async function embedChunks(
  chunks: Chunk[],
  embeddings: IEmbeddings,
  onProgress?: (done: number, total: number) => void,
): Promise<VectorRecord[]> {
  if (chunks.length === 0) {
    return [];
  }

  const records: VectorRecord[] = [];
  for (const batch of planBatches(chunks)) {
    const vectors = await embeddings.embedBatch(batch.map((b) => b.text));
    // Store the original chunk text in metadata, even if the embedded text was truncated.
    batch.forEach((b, j) => records.push(toRecord(b.chunk, vectors[j] ?? [], b.chunk.text)));
    onProgress?.(records.length, chunks.length);
  }
  return records;
}
