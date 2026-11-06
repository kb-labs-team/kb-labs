/**
 * @module @kb-labs/review/heuristic/deduplication
 * Fingerprint-based deduplication with engine type priority.
 *
 * Deduplicates findings from multiple engines using:
 * 1. Fingerprint collision detection (sha1(ruleId|file|bucket|snippetHash))
 * 2. Engine type priority (compiler > linter > sast > ast > llm)
 * 3. Severity adjustment (higher severity wins if same type)
 */

import { createHash } from 'node:crypto';
import type { ReviewFinding, FindingSeverity } from '../contracts/index.js';
import { getEngineTypePriority } from './engine-registry.js';

/**
 * Generate fingerprint for a finding.
 *
 * Fingerprint = sha1(ruleId|file|bucket|snippetHash)
 * - ruleId: Rule identifier
 * - file: File path
 * - bucket: Line bucket (e.g., lines 10-19 → bucket 1)
 * - snippetHash: Hash of code snippet (optional)
 */
export function generateFingerprint(
  finding: ReviewFinding,
  snippetHash?: string
): string {
  const bucket = Math.floor(finding.line / 10);
  const parts = [finding.ruleId, finding.file, bucket.toString()];

  if (snippetHash) {
    parts.push(snippetHash);
  }

  const input = parts.join('|');
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Hash code snippet for fingerprint.
 */
export function hashSnippet(snippet: string): string {
  return createHash('sha1').update(snippet.trim()).digest('hex');
}

/**
 * Get severity weight for comparison.
 *
 * Higher number = more severe.
 */
function getSeverityWeight(severity: FindingSeverity): number {
  const weights: Record<FindingSeverity, number> = {
    blocker: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  return weights[severity] ?? 0;
}

/**
 * Deduplicate findings using fingerprints and engine type priority.
 *
 * Algorithm:
 * 1. Group findings by fingerprint
 * 2. For each collision group:
 *    - Sort by engine type priority (compiler > linter > sast > ast > llm)
 *    - If same type, sort by severity (blocker > high > medium > low > info)
 *    - Keep highest priority finding, discard rest
 *
 * @param findings - All findings from all engines
 * @returns Deduplicated findings
 */
export function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  // Generate fingerprints
  const fingerprintMap = new Map<string, ReviewFinding[]>();

  for (const finding of findings) {
    const fingerprint = generateFingerprint(finding);

    if (!fingerprintMap.has(fingerprint)) {
      fingerprintMap.set(fingerprint, []);
    }

    fingerprintMap.get(fingerprint)!.push(finding);
  }

  // Deduplicate each collision group
  const deduplicated: ReviewFinding[] = [];

  for (const group of fingerprintMap.values()) {
    if (group.length === 0) {
      continue;
    }

    if (group.length === 1) {
      // No collision, keep as-is
      deduplicated.push(group[0]!);
      continue;
    }

    // Sort by priority
    const sorted = group.sort((a, b) => {
      // 1. Engine type priority (lower number = higher priority)
      const aPriority = getEngineTypePriority(a.engine);
      const bPriority = getEngineTypePriority(b.engine);

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // 2. Severity (higher severity wins)
      const aSeverity = getSeverityWeight(a.severity);
      const bSeverity = getSeverityWeight(b.severity);

      return bSeverity - aSeverity;
    });

    // Keep highest priority finding
    const best = sorted[0];
    if (best) {
      deduplicated.push(best);
    }
  }

  return deduplicated;
}

/**
 * Deduplicate findings with snippet-based fingerprints.
 *
 * More precise deduplication using code snippets.
 *
 * @param findings - All findings
 * @param getSnippet - Function to get code snippet for a finding
 * @returns Deduplicated findings
 */
export async function deduplicateFindingsWithSnippets(
  findings: ReviewFinding[],
  getSnippet: (finding: ReviewFinding) => Promise<string>
): Promise<ReviewFinding[]> {
  // Generate fingerprints with snippets
  const fingerprintMap = new Map<string, ReviewFinding[]>();

  for (const finding of findings) {
    // eslint-disable-next-line no-await-in-loop -- Sequential snippet fetching for fingerprinting
    const snippet = await getSnippet(finding);
    const snippetHash = hashSnippet(snippet);
    const fingerprint = generateFingerprint(finding, snippetHash);

    if (!fingerprintMap.has(fingerprint)) {
      fingerprintMap.set(fingerprint, []);
    }

    fingerprintMap.get(fingerprint)!.push(finding);
  }

  // Deduplicate each collision group
  const deduplicated: ReviewFinding[] = [];

  for (const group of fingerprintMap.values()) {
    if (group.length === 0) {
      continue;
    }

    if (group.length === 1) {
      deduplicated.push(group[0]!);
      continue;
    }

    // Sort by priority
    const sorted = group.sort((a, b) => {
      const aPriority = getEngineTypePriority(a.engine);
      const bPriority = getEngineTypePriority(b.engine);

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      const aSeverity = getSeverityWeight(a.severity);
      const bSeverity = getSeverityWeight(b.severity);

      return bSeverity - aSeverity;
    });

    const best = sorted[0];
    if (best) {
      deduplicated.push(best);
    }
  }

  return deduplicated;
}
