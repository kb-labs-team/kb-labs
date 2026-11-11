/**
 * JSON reporter for release reports
 */

import type { ReleaseReport } from '../types';

export function renderJson(report: ReleaseReport): string {
  return JSON.stringify(report, null, 2);
}

