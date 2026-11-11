/**
 * Corpus reader for the grep-vs-mind head-to-head.
 *
 * Walks a directory and returns each source file's repo-relative path + text.
 * The grep baseline MUST score over the SAME set the engine indexes, otherwise
 * the head-to-head compares Mind-over-one-corpus against grep-over-another and
 * the delta is meaningless. So this mirrors the engine's discovery policy
 * (plugins/mind/src/core/ingest/discover.ts): keep any text file, exclude the
 * same binary/asset/data/lock families via denylist + a NUL-byte binary sniff —
 * NOT a hand-picked extension allowlist (which silently dropped .cs/.vue/.json).
 */

import fs from 'node:fs'
import path from 'node:path'

export interface CorpusFile {
  /** Repo-relative path (matches what /search returns, suffix-comparable to golden). */
  path: string
  text: string
}

// Kept in sync with discover.ts DENY_EXT/IGNORE/MAX_BYTES (same classification).
const DENY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'tif', 'tiff', 'avif',
  'mp4', 'mov', 'avi', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'pdf',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'node', 'pdb',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'parquet', 'db', 'sqlite',
  'map', 'min.js', 'min.css', 'snap',
  'csv', 'tsv', 'ndjson', 'jsonl', 'log', 'sql', 'dump', 'out',
])
const DENY_FILE = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock', 'composer.lock',
])
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.kb',
  'bin', 'obj', '.next', '.nuxt', 'vendor', '__pycache__', 'report',
])
const MAX_BYTES = 512 * 1024

function extOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  if (name.endsWith('.min.js')) {
    return 'min.js'
  }
  if (name.endsWith('.min.css')) {
    return 'min.css'
  }
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1)
}

/** NUL byte in the first 4 KB ⇒ binary (same sniff as discover.ts). */
function isBinary(abs: string): boolean {
  let fd: number | undefined
  try {
    fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(4096)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) {
        return true
      }
    }
    return false
  } catch {
    return true
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }
}

/** Recursively read source files under `rootDir` (absolute), relative to `repoRoot`. */
export function readCorpus(rootDir: string, repoRoot: string): CorpusFile[] {
  const out: CorpusFile[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue // dotfiles/dirs — matches discover's dot:false
      }
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) {
          walk(abs)
        }
        continue
      }
      if (DENY_FILE.has(entry.name) || DENY_EXT.has(extOf(entry.name))) {
        continue
      }
      let size = 0
      try {
        size = fs.statSync(abs).size
      } catch {
        continue
      }
      if (size === 0 || size > MAX_BYTES || isBinary(abs)) {
        continue
      }
      out.push({ path: path.relative(repoRoot, abs), text: fs.readFileSync(abs, 'utf8') })
    }
  }
  walk(rootDir)
  return out
}
