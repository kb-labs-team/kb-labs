/**
 * @module @kb-labs/review/heuristic/engines
 * Linter engine definitions.
 */

export type { LinterEngine, LinterResult } from './types.js';
export { eslintEngine } from './eslint.js';
export { ruffEngine } from './ruff.js';

import { eslintEngine } from './eslint.js';
import { ruffEngine } from './ruff.js';
import type { LinterEngine } from './types.js';

/**
 * All available linter engines.
 */
export const LINTER_ENGINES: LinterEngine[] = [
  eslintEngine,
  ruffEngine,
];

/**
 * Get engine by ID.
 */
export function getLinterEngine(id: string): LinterEngine | undefined {
  return LINTER_ENGINES.find(e => e.id === id);
}

/**
 * Get engine for file extension.
 */
export function getLinterEngineForFile(filePath: string): LinterEngine | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return LINTER_ENGINES.find(e => e.extensions.includes(ext));
}
