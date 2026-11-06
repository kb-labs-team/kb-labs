/**
 * ToolInputNormalizer — SDK InputNormalizer implementation.
 *
 * Normalizes tool inputs before guards and execution:
 *   - Path resolution: .bak/.backup/.orig/.tmp → source file, .js → .ts/.tsx
 *   - Glob expansion: bare filename → `**\/*name*`
 *   - Adaptive read limits per tier
 *   - Directory field normalization for search tools
 *   - Shell cwd defaulting
 *   - Secondary artifact blocking (dist/, build/, .map, .min.js)
 *
 * Stateful: tracks per-file read attempts for adaptive limits.
 * Create one instance per agent run.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { InputNormalizer, ToolExecCtx } from '../../sdk/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ToolInputNormalizerConfig {
  workingDir: string;
}

// ─── Tier-based read limits ──────────────────────────────────────────────────

const TIER_BASELINES = {
  small:  180,
  medium: 300,
  large:  500,
} as const;

const TIER_BASELINES_LARGE_FILE = {
  small:  280,
  medium: 650,
  large:  1000,
} as const;

const TIER_BASELINES_MED_FILE = {
  small:  240,
  medium: 500,
  large:  900,
} as const;

const MAX_READ_LIMIT = 1000;
const SMALL_FILE_THRESHOLD = 500;

// ─── ToolInputNormalizer ─────────────────────────────────────────────────────

export class ToolInputNormalizer implements InputNormalizer {
  readonly name = 'tool-input';

  private readonly workingDir: string;
  private readonly fileReadAttempts = new Map<string, number>();

  constructor(config: ToolInputNormalizerConfig) {
    this.workingDir = config.workingDir;
  }

  normalize(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecCtx,
  ): Record<string, unknown> {
    const normalized = { ...input };

    // Directory normalization for search tools
    if (
      toolName === 'glob_search'
      || toolName === 'grep_search'
      || toolName === 'find_definition'
      || toolName === 'code_stats'
    ) {
      this.normalizeDirectoryField(normalized);
    }

    // Glob pattern expansion
    if (toolName === 'glob_search') {
      this.normalizeGlobPattern(normalized);
    }

    // File read: path resolution + adaptive limits
    if (toolName === 'fs_read' && typeof normalized.path === 'string') {
      this.normalizeFileRead(normalized, ctx);
    }

    // Shell cwd defaulting
    if (toolName === 'shell_exec') {
      const rawCwd = typeof normalized.cwd === 'string' ? normalized.cwd.trim() : '';
      if (!rawCwd) {
        normalized.cwd = '.';
      }
    }

    return normalized;
  }

  // ── Glob pattern normalization ─────────────────────────────────────────────

  private normalizeGlobPattern(input: Record<string, unknown>): void {
    // If query is provided but not pattern, use query as pattern
    const pattern =
      typeof input.pattern === 'string'
        ? input.pattern
        : typeof input.query === 'string'
          ? input.query
          : '';

    if (pattern && typeof input.pattern !== 'string') {
      input.pattern = pattern;
    }

    if (typeof input.pattern === 'string') {
      const trimmed = input.pattern.trim();
      const hasGlobMeta = /[*?[\]{}]/.test(trimmed);
      // Bare filename without glob chars → wrap in glob pattern
      if (trimmed && !hasGlobMeta) {
        input.pattern = `**/*${trimmed}*`;
      }
    }
  }

  // ── File read normalization ────────────────────────────────────────────────

  private normalizeFileRead(input: Record<string, unknown>, ctx: ToolExecCtx): void {
    const filePath = (input.path as string).trim();

    // Path resolution: .bak → source, .js → .ts
    const resolvedPath = this.resolveSourcePath(filePath);
    if (resolvedPath) {
      input.path = resolvedPath;
    }

    // Block secondary artifacts (dist/, build/, .map, .min.js)
    const finalPath = String(input.path);
    if (isSecondaryArtifact(finalPath)) {
      // Don't block — just log via meta. Guards can enforce if needed.
      ctx.run.meta.set('normalizer', 'blocked_artifact', finalPath);
    }

    // Offset normalization
    const currentOffset = Number(input.offset);
    const safeOffset = Number.isFinite(currentOffset) && currentOffset > 0
      ? Math.floor(currentOffset)
      : 1;
    input.offset = safeOffset;

    // Adaptive read limit
    const requestedLimit = Number(input.limit);
    const adaptiveLimit = this.computeAdaptiveLimit(
      finalPath,
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.floor(requestedLimit)
        : undefined,
      ctx.run.tier,
    );
    if (adaptiveLimit > 0) {
      input.limit = adaptiveLimit;
    }
  }

  // ── Path resolution ────────────────────────────────────────────────────────

  private resolveSourcePath(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');

    // Try removing backup suffixes (.bak, .backup, .orig, .tmp)
    const backupResult = this.tryResolvePrimarySource(normalized);
    if (backupResult) {return backupResult;}

    // Try .js → .ts/.tsx
    const tsResult = this.tryResolveTsSource(normalized);
    if (tsResult) {return tsResult;}

    return null;
  }

  private tryResolvePrimarySource(filePath: string): string | null {
    const lower = filePath.toLowerCase();
    const suffixes = ['.backup', '.bak', '.orig', '.tmp'];
    const matched = suffixes.find(s => lower.endsWith(s));
    if (!matched) {return null;}

    const candidate = filePath.slice(0, filePath.length - matched.length);
    const abs = path.isAbsolute(candidate) ? candidate : path.join(this.workingDir, candidate);

    if (!existsSafe(abs)) {return null;}
    return path.isAbsolute(filePath) ? abs : candidate;
  }

  private tryResolveTsSource(filePath: string): string | null {
    if (!filePath.endsWith('.js')) {return null;}

    const base = filePath.slice(0, -3);
    for (const ext of ['.ts', '.tsx']) {
      const candidate = base + ext;
      const abs = path.isAbsolute(candidate) ? candidate : path.join(this.workingDir, candidate);
      if (existsSafe(abs)) {
        return path.isAbsolute(filePath) ? abs : candidate;
      }
    }
    return null;
  }

  // ── Adaptive read limits ───────────────────────────────────────────────────

  private computeAdaptiveLimit(
    filePath: string,
    requestedLimit: number | undefined,
    tier: string,
  ): number {
    const attempts = (this.fileReadAttempts.get(filePath) ?? 0) + 1;
    this.fileReadAttempts.set(filePath, attempts);

    // If user explicitly requested a large limit, respect it (capped)
    if (requestedLimit && requestedLimit >= 120) {
      return Math.min(MAX_READ_LIMIT, requestedLimit);
    }

    // Get file size for adaptive baseline
    const fileLines = this.getFileLineCount(filePath);
    let baseline: number = TIER_BASELINES[tier as keyof typeof TIER_BASELINES] ?? TIER_BASELINES.medium;

    if (fileLines !== null) {
      if (fileLines <= SMALL_FILE_THRESHOLD) {
        // Small file — read it all
        baseline = Math.min(MAX_READ_LIMIT, fileLines);
      } else if (fileLines >= 3000) {
        baseline = TIER_BASELINES_LARGE_FILE[tier as keyof typeof TIER_BASELINES_LARGE_FILE] ?? TIER_BASELINES_LARGE_FILE.medium;
      } else if (fileLines >= 1500) {
        baseline = TIER_BASELINES_MED_FILE[tier as keyof typeof TIER_BASELINES_MED_FILE] ?? TIER_BASELINES_MED_FILE.medium;
      }
    }

    // Scale up for repeated reads (agent is clearly interested in this file)
    if (attempts >= 5) {
      baseline = Math.min(MAX_READ_LIMIT, Math.round(baseline * 1.6));
    } else if (attempts >= 3) {
      baseline = Math.min(MAX_READ_LIMIT, Math.round(baseline * 1.4));
    }

    // If user requested a small limit, use at least the baseline
    if (requestedLimit && requestedLimit > 0) {
      return Math.min(MAX_READ_LIMIT, Math.max(requestedLimit, baseline));
    }

    return Math.min(MAX_READ_LIMIT, baseline);
  }

  private getFileLineCount(filePath: string): number | null {
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workingDir, filePath);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) {return null;}
      // Estimate: ~40 chars per line average for source code
      return Math.ceil(stat.size / 40);
    } catch {
      return null;
    }
  }

  // ── Directory normalization ────────────────────────────────────────────────

  private normalizeDirectoryField(input: Record<string, unknown>): void {
    if (typeof input.directory !== 'string') {return;}

    const raw = input.directory.trim();
    if (!raw || raw === '.') {return;}

    const abs = path.isAbsolute(raw) ? raw : path.resolve(this.workingDir, raw);

    if (existsSafe(abs)) {
      try {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          // Directory field points to a file — use its parent
          const rel = path.relative(this.workingDir, path.dirname(abs));
          input.directory = (!rel || rel === '.') ? '.' : (rel.startsWith('..') ? '.' : rel);
        }
      } catch { /* keep original */ }
      return;
    }

    // Path doesn't exist but looks like a file (has extension) — use parent
    if (/\.[a-z0-9]+$/i.test(raw)) {
      const parentDir = path.dirname(abs);
      if (existsSafe(parentDir)) {
        try {
          if (fs.statSync(parentDir).isDirectory()) {
            const rel = path.relative(this.workingDir, parentDir);
            input.directory = (!rel || rel === '.') ? '.' : (rel.startsWith('..') ? '.' : rel);
          }
        } catch { /* keep original */ }
      }
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function existsSafe(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isSecondaryArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/dist/')
    || normalized.includes('/build/')
    || normalized.endsWith('.map')
    || normalized.endsWith('.min.js')
    || normalized.includes('.backup')
    || normalized.endsWith('.bak')
    || normalized.endsWith('.orig')
    || normalized.endsWith('.tmp')
  );
}
