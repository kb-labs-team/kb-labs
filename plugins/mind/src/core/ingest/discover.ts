/**
 * Adaptive source-file discovery via `globby` over the real filesystem.
 *
 * Reads the repo relative to `cwd` — NOT the platform `storage` adapter, which
 * is a blob store that recurses into node_modules and chokes on pnpm symlink
 * chains. Symlinks are not followed and dependency/build dirs are excluded.
 *
 * No language allowlist: we glob every file and KEEP whatever looks like source
 * text, excluding only binaries, media, archives, data blobs, lockfiles and
 * oversized/generated files. A new language (`.cs`, `.vue`, `.kt`, …) is indexed
 * automatically — discovery adapts to the repo instead of being hand-curated.
 *
 * Returns paths relative to `cwd`.
 */

import globby from 'globby';
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

const IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.kb/**',
  '**/bin/**',
  '**/obj/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/vendor/**',
  '**/__pycache__/**',
];

/**
 * Non-source extensions — binary, media, archives, data blobs, sourcemaps,
 * minified bundles. Everything NOT here is treated as source if it is text.
 */
const DENY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'tif', 'tiff', 'avif',
  'mp4', 'mov', 'avi', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'pdf',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'node', 'pdb',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'parquet', 'db', 'sqlite',
  'map', 'min.js', 'min.css', 'snap',
  // Bulk data / logs / dumps — text, but no semantic value and they bloat the
  // index + embedding cost (the old extension allowlist excluded these by omission).
  'csv', 'tsv', 'ndjson', 'jsonl', 'log', 'sql', 'dump', 'out',
]);

/** Generated/lock files that are text but carry no semantic signal. */
const DENY_FILE = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock', 'composer.lock',
]);

/** Skip empty and oversized (usually generated/minified) files. */
const MAX_BYTES = 512 * 1024;

function extOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  if (name.endsWith('.min.js')) {
    return 'min.js';
  }
  if (name.endsWith('.min.css')) {
    return 'min.css';
  }
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/** Cheap binary sniff: a NUL byte in the first 4 KB ⇒ treat as binary. */
function isBinary(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return true; // unreadable ⇒ skip
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** Strip trailing slashes without a backtracking regex (avoids polynomial ReDoS). */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return s.slice(0, end);
}

/** Scope the engine discovers against — config-driven include/exclude globs. */
export interface DiscoverScope {
  /** Repo-relative roots/globs to index. Empty/undefined ⇒ whole repo. */
  include?: string[];
  /** Globs subtracted from the include set (added to the ignore list). */
  exclude?: string[];
}

export async function discover(cwd: string, scope?: DiscoverScope): Promise<string[]> {
  const include = scope?.include && scope.include.length > 0 ? scope.include : ['.'];
  const exclude = scope?.exclude ?? [];

  // Each include root → a recursive glob ('.' ⇒ whole repo). exclude globs
  // join the ignore list, so they're subtracted from whatever include matched.
  const patterns = include.map((p) => {
    const base = p && p !== '.' ? trimTrailingSlashes(p) : '';
    return base ? `${base}/**/*` : '**/*';
  });

  const candidates = await globby(patterns, {
    cwd,
    ignore: [...IGNORE, ...exclude],
    dot: false,
    followSymbolicLinks: false,
    gitignore: false,
    onlyFiles: true,
  });

  return candidates.filter((rel) => {
    if (DENY_FILE.has(rel.slice(rel.lastIndexOf('/') + 1))) {
      return false;
    }
    if (DENY_EXT.has(extOf(rel))) {
      return false;
    }
    const abs = path.join(cwd, rel);
    try {
      const st = statSync(abs);
      if (st.size === 0 || st.size > MAX_BYTES) {
        return false;
      }
    } catch {
      return false;
    }
    return !isBinary(abs);
  });
}
