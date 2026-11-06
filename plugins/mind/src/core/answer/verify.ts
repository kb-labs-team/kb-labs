/**
 * Anti-hallucination verification + confidence stack.
 *
 * Each retrieved chunk is verified against the live source via `IStorage`:
 * file exists (0.7) + snippet still present (0.3). The verification rate scales
 * the retrieval confidence — a stale or fabricated source drags confidence down.
 * Mirrors the legacy mind concept (source-verifier + confidence floor).
 */

import type { AgentWarning } from '../../contracts/index.js';
import type { IStorage } from '../services';
import type { RankedChunk } from '../retrieval/retrieve';

export interface VerificationResult {
  /** 0..1 fraction of (weighted) verification across chunks. */
  rate: number;
  /** Per-chunk verification score (0..1), aligned with input order. */
  perChunk: number[];
}

const FILE_WEIGHT = 0.7;
const SNIPPET_WEIGHT = 0.3;

export async function verifySources(ranked: RankedChunk[], storage: IStorage): Promise<VerificationResult> {
  if (ranked.length === 0) {
    return { rate: 1, perChunk: [] };
  }

  const perChunk: number[] = [];
  for (const { chunk } of ranked) {
    const exists = await storage.exists(chunk.path);
    let score = exists ? FILE_WEIGHT : 0;
    if (exists) {
      const buf = await storage.read(chunk.path);
      const content = buf?.toString('utf8') ?? '';
      // Snippet grounding: a representative line of the chunk is still present.
      const probe = chunk.text.split('\n').find((l) => l.trim().length > 8)?.trim();
      if (probe && content.includes(probe)) {
        score += SNIPPET_WEIGHT;
      }
    }
    perChunk.push(score);
  }

  const rate = perChunk.reduce((a, b) => a + b, 0) / perChunk.length;
  return { rate, perChunk };
}

export interface ConfidenceResult {
  confidence: number;
  warnings: AgentWarning[];
}

/** Combine retrieval confidence with the verification rate; warn below floor. */
export function computeConfidence(
  retrievalConfidence: number,
  verificationRate: number,
  floor: number,
): ConfidenceResult {
  const confidence = Math.max(0, Math.min(1, retrievalConfidence * verificationRate));
  const warnings: AgentWarning[] = [];
  if (confidence < floor) {
    warnings.push({
      code: 'LOW_CONFIDENCE',
      message: `Confidence ${confidence.toFixed(2)} is below the floor ${floor.toFixed(2)}; the answer may be unreliable.`,
    });
  }
  return { confidence, warnings };
}
