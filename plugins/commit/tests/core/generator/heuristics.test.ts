import { describe, expect, it } from 'vitest';
import { generateHeuristicPlan } from '../../../src/core/generator/heuristics.js';
import type { FileSummary } from '@kb-labs/commit/contracts';

function summary(path: string, status: FileSummary['status'] = 'added'): FileSummary {
  return { path, status, additions: 1, deletions: 0, binary: false, isNewFile: status === 'added' };
}

describe('generateHeuristicPlan file kinds', () => {
  it('classifies source, test, docs, config, and lockfile changes', () => {
    const plan = generateHeuristicPlan([
      summary('math.js'),
      summary('src/math.test.js'),
      summary('README.md'),
      summary('tsconfig.json'),
      summary('pnpm-lock.yaml'),
    ]);

    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'feat', message: 'add 1 file', files: ['math.js'] }),
      expect.objectContaining({ type: 'test', message: 'add 1 test file', files: ['src/math.test.js'] }),
      expect.objectContaining({ type: 'docs', message: 'add documentation', files: ['README.md'] }),
      expect.objectContaining({ type: 'chore', message: 'update configuration', files: ['tsconfig.json'] }),
      expect.objectContaining({ type: 'chore', message: 'update dependencies', files: ['pnpm-lock.yaml'] }),
    ]));
  });
});
