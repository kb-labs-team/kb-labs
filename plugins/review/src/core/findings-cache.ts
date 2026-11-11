/**
 * @module @kb-labs/review/core/findings-cache
 * Cache for LLM review findings based on file content hash.
 *
 * Enables incremental review:
 * - Skip unchanged files (return cached findings)
 * - Track "known issues" vs "new issues" for changed files
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ReviewFinding, InputFile } from '../contracts/index.js';

/**
 * Cached finding with file hash
 */
export interface CachedFinding extends ReviewFinding {
  /** Hash of file content when finding was created */
  contentHash: string;
  /** Timestamp when finding was cached */
  cachedAt: number;
}

/**
 * Cache entry for a single file
 */
export interface FileCacheEntry {
  /** File path */
  path: string;
  /** Content hash */
  contentHash: string;
  /** Findings for this file */
  findings: CachedFinding[];
  /** When this entry was created */
  createdAt: number;
  /** When this entry was last accessed */
  lastAccessedAt: number;
}

/**
 * Full cache structure
 */
export interface FindingsCacheData {
  /** Version for cache format migrations */
  version: number;
  /** Cache entries by file path */
  entries: Record<string, FileCacheEntry>;
  /** Cache metadata */
  metadata: {
    createdAt: number;
    lastUpdatedAt: number;
    totalFindings: number;
    totalFiles: number;
  };
}

/**
 * Result of cache lookup
 */
export interface CacheLookupResult {
  /** Files that have valid cache (unchanged) */
  cached: {
    file: InputFile;
    findings: ReviewFinding[];
  }[];
  /** Files that need fresh analysis (changed or not cached) */
  uncached: InputFile[];
  /** Statistics */
  stats: {
    cachedFiles: number;
    uncachedFiles: number;
    cachedFindings: number;
  };
}

/**
 * Result of incremental comparison
 */
export interface IncrementalResult {
  /** New findings (not seen before) */
  newFindings: ReviewFinding[];
  /** Known findings (seen in previous review) */
  knownFindings: ReviewFinding[];
  /** Findings from unchanged (cached) files */
  cachedFindings: ReviewFinding[];
  /** Statistics */
  stats: {
    new: number;
    known: number;
    cached: number;
    total: number;
  };
}

const CACHE_VERSION = 2;
const CACHE_FILENAME = 'llm-findings-cache.json';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EMPTY_FINDINGS_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour — short TTL for 0-findings to handle LLM variance

/**
 * Generate content hash for a file.
 *
 * Uses SHA-256 for cryptographic strength, truncated to 16 hex chars (64 bits).
 * This provides sufficient collision resistance for cache invalidation while
 * keeping cache keys reasonably short.
 *
 * @param content - File content to hash
 * @returns 16-character hex string (first 64 bits of SHA-256)
 */
export function hashFileContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Generate finding signature for deduplication
 * Two findings are "same" if they have same file, line range, and category
 */
export function findingSignature(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}:${finding.endLine ?? finding.line}:${finding.type}`;
}

/**
 * Findings cache manager
 */
export class FindingsCache {
  private cwd: string;
  private cachePath: string;
  private data: FindingsCacheData | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.cachePath = join(cwd, '.kb', 'review', 'cache', CACHE_FILENAME);
  }

  /**
   * Load cache from disk
   */
  async load(): Promise<void> {
    try {
      const content = await readFile(this.cachePath, 'utf-8');
      const parsed = JSON.parse(content) as FindingsCacheData;

      // Version check
      if (parsed.version !== CACHE_VERSION) {
        // Cache format changed, start fresh
        this.data = this.createEmptyCache();
        return;
      }

      this.data = parsed;
    } catch {
      // No cache or invalid, start fresh
      this.data = this.createEmptyCache();
    }
  }

  /**
   * Save cache to disk
   */
  async save(): Promise<void> {
    if (!this.data) {
      return;
    }

    this.data.metadata.lastUpdatedAt = Date.now();

    // Ensure directory exists
    await mkdir(dirname(this.cachePath), { recursive: true });

    await writeFile(this.cachePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Look up files in cache
   * Returns which files can use cached findings vs need fresh analysis
   */
  lookup(files: InputFile[]): CacheLookupResult {
    if (!this.data) {
      return {
        cached: [],
        uncached: files,
        stats: { cachedFiles: 0, uncachedFiles: files.length, cachedFindings: 0 },
      };
    }

    const cached: CacheLookupResult['cached'] = [];
    const uncached: InputFile[] = [];
    let cachedFindings = 0;

    for (const file of files) {
      const hash = hashFileContent(file.content);
      const entry = this.data.entries[file.path];

      const maxAge = entry && entry.findings.length === 0 ? EMPTY_FINDINGS_MAX_AGE_MS : DEFAULT_MAX_AGE_MS;
      const isExpired = entry ? (Date.now() - entry.createdAt) > maxAge : false;

      if (entry && entry.contentHash === hash && !isExpired) {
        // File unchanged and cache is fresh, use cached findings
        cached.push({
          file,
          findings: entry.findings.map(f => this.stripCacheFields(f)),
        });
        cachedFindings += entry.findings.length;

        // Update last accessed
        entry.lastAccessedAt = Date.now();
      } else {
        // File changed or not cached
        uncached.push(file);
      }
    }

    return {
      cached,
      uncached,
      stats: {
        cachedFiles: cached.length,
        uncachedFiles: uncached.length,
        cachedFindings,
      },
    };
  }

  /**
   * Update cache with new findings
   */
  update(files: InputFile[], findings: ReviewFinding[]): void {
    if (!this.data) {
      this.data = this.createEmptyCache();
    }

    // Group findings by file
    const findingsByFile = new Map<string, ReviewFinding[]>();
    for (const finding of findings) {
      const existing = findingsByFile.get(finding.file) ?? [];
      existing.push(finding);
      findingsByFile.set(finding.file, existing);
    }

    // Update cache entries
    for (const file of files) {
      const hash = hashFileContent(file.content);
      const fileFindings = findingsByFile.get(file.path) ?? [];

      const cachedFindings: CachedFinding[] = fileFindings.map(f => ({
        ...f,
        contentHash: hash,
        cachedAt: Date.now(),
      }));

      this.data.entries[file.path] = {
        path: file.path,
        contentHash: hash,
        findings: cachedFindings,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
    }

    // Update metadata
    this.data.metadata.totalFiles = Object.keys(this.data.entries).length;
    this.data.metadata.totalFindings = Object.values(this.data.entries)
      .reduce((sum, entry) => sum + entry.findings.length, 0);
  }

  /**
   * Compare new findings with cached to find new vs known issues
   */
  compareIncremental(
    newFindings: ReviewFinding[],
    cachedFindings: ReviewFinding[]
  ): IncrementalResult {
    // Build set of known finding signatures
    const knownSignatures = new Set<string>();

    // Add signatures from cache
    if (this.data) {
      for (const entry of Object.values(this.data.entries)) {
        for (const finding of entry.findings) {
          knownSignatures.add(findingSignature(finding));
        }
      }
    }

    // Separate new vs known
    const newIssues: ReviewFinding[] = [];
    const knownIssues: ReviewFinding[] = [];

    for (const finding of newFindings) {
      const sig = findingSignature(finding);
      if (knownSignatures.has(sig)) {
        knownIssues.push(finding);
      } else {
        newIssues.push(finding);
      }
    }

    return {
      newFindings: newIssues,
      knownFindings: knownIssues,
      cachedFindings,
      stats: {
        new: newIssues.length,
        known: knownIssues.length,
        cached: cachedFindings.length,
        total: newIssues.length + knownIssues.length + cachedFindings.length,
      },
    };
  }

  /**
   * Clear cache for specific files or all
   */
  clear(files?: string[]): void {
    if (!this.data) {
      return;
    }

    if (files) {
      for (const file of files) {
        delete this.data.entries[file];
      }
    } else {
      this.data = this.createEmptyCache();
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { totalFiles: number; totalFindings: number; cacheAge: number } {
    if (!this.data) {
      return { totalFiles: 0, totalFindings: 0, cacheAge: 0 };
    }
    return {
      totalFiles: this.data.metadata.totalFiles,
      totalFindings: this.data.metadata.totalFindings,
      cacheAge: Date.now() - this.data.metadata.createdAt,
    };
  }

  private createEmptyCache(): FindingsCacheData {
    return {
      version: CACHE_VERSION,
      entries: {},
      metadata: {
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
        totalFindings: 0,
        totalFiles: 0,
      },
    };
  }

  private stripCacheFields(finding: CachedFinding): ReviewFinding {
    const { contentHash: _contentHash, cachedAt: _cachedAt, ...rest } = finding;
    return rest;
  }
}

/**
 * Create findings cache instance
 */
export function createFindingsCache(cwd: string): FindingsCache {
  return new FindingsCache(cwd);
}
