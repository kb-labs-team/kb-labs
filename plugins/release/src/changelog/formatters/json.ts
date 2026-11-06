/**
 * JSON manifest formatter with integrity hashes
 */

import { createHash } from 'node:crypto';
import type { ReleaseManifest, PackageRelease } from '../types';

/**
 * Format ReleaseManifest as JSON string with integrity hashes
 */
export function formatAsJson(
  manifest: ReleaseManifest,
  additionalContent?: Record<string, string>
): string {
  // Calculate integrity hashes
  const integrity: Record<string, string> = {};
  
  for (const [key, content] of Object.entries(additionalContent || {})) {
    integrity[key] = calculateSha256(content);
  }
  
  const manifestWithIntegrity = {
    ...manifest,
    integrity: Object.keys(integrity).length > 0 ? integrity : undefined,
  };
  
  return JSON.stringify(manifestWithIntegrity, null, 2);
}

/**
 * Create ReleaseManifest from data
 */
export function createReleaseManifest(
  range: { from: string; to: string },
  packages: PackageRelease[],
  timestamp?: string
): ReleaseManifest {
  const byType: Record<string, number> = {};
  let breakingCount = 0;
  
  for (const pkg of packages) {
    // Count breaking changes
    breakingCount += pkg.breaking.length;
    
    // Count by type
    for (const change of pkg.changes) {
      byType[change.type] = (byType[change.type] || 0) + 1;
    }
  }
  
  return {
    schemaVersion: '1.0',
    range,
    timestamp: timestamp || new Date().toISOString(),
    packages,
    workspace: {
      breakingCount,
      byType,
    },
  };
}

/**
 * Calculate SHA256 hash
 */
function calculateSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}


