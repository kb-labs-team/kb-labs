/**
 * Retrieval-quality metrics for the benchmark harness.
 *
 * All functions take the ranked list of retrieved file paths (best first) and
 * the set of relevant paths (optionally graded for nDCG).
 */

export interface GradedRelevant {
  path: string;
  grade: number; // 1..3
}

export function hitAtK(retrieved: string[], relevant: string[], k: number): number {
  const top = new Set(retrieved.slice(0, k));
  return relevant.some((r) => top.has(r)) ? 1 : 0;
}

export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) {
    return 1;
  }
  const top = new Set(retrieved.slice(0, k));
  const found = relevant.filter((r) => top.has(r)).length;
  return found / relevant.length;
}

export function precisionAtK(retrieved: string[], relevant: string[], k: number): number {
  if (k === 0) {
    return 0;
  }
  const rel = new Set(relevant);
  const top = retrieved.slice(0, k);
  const found = top.filter((p) => rel.has(p)).length;
  return found / Math.min(k, top.length || k);
}

export function mrr(retrieved: string[], relevant: string[]): number {
  const rel = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (rel.has(retrieved[i]!)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function ndcgAtK(retrieved: string[], graded: GradedRelevant[], k: number): number {
  const gradeOf = new Map(graded.map((g) => [g.path, g.grade]));
  let dcg = 0;
  retrieved.slice(0, k).forEach((path, i) => {
    const g = gradeOf.get(path) ?? 0;
    dcg += (Math.pow(2, g) - 1) / Math.log2(i + 2);
  });
  const ideal = [...graded]
    .sort((a, b) => b.grade - a.grade)
    .slice(0, k);
  let idcg = 0;
  ideal.forEach((g, i) => {
    idcg += (Math.pow(2, g.grade) - 1) / Math.log2(i + 2);
  });
  return idcg === 0 ? 0 : dcg / idcg;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
