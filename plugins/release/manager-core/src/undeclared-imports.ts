/**
 * Detect runtime imports in a packed package's shipped `dist` code that the
 * package's manifest does not declare.
 *
 * Why this exists: the aggregated clean install of `pack-install` puts every
 * platform package into ONE consumer, and npm hoists a dependency declared by
 * package Y next to package X. If X imports `foo` but forgot to declare it,
 * X's import pass still succeeds there, while a real consumer installing only
 * X gets ERR_MODULE_NOT_FOUND. Only a static check can see that.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

export interface ManifestDeps {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bundledDependencies?: unknown;
  bundleDependencies?: unknown;
}

/**
 * Blank out comments so commented-out imports are not reported. Strings are
 * skipped correctly (`//` inside "http://x" is not a comment).
 *
 * Known limitations of this cheap scanner: a regex literal containing a quote
 * character and `${}` nesting inside template literals can desynchronise it.
 * The worst case is a missed or an extra specifier in that one file;
 * `undeclaredImportAllowlist` covers false positives. Text inside a string
 * that looks like `from 'x'` is also reported.
 */
export function stripJsComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { i++; }
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { i++; }
      i += 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += src[i]!; i++; }
        if (i < n) { out += src[i]!; i++; }
        if (c !== '`' && src[i] === '\n') { break; }
      }
      if (i < n) { out += src[i]!; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g, // import x from 'a' / export * from 'a'
  /\bimport\s*(['"])([^'"\n]+)\1/g, // import 'a'
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, // import('a')
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, // require('a')
];

/** Bare import specifiers of one JS source; relative, absolute, `#imports` and URL-like ones are dropped. */
export function extractBareSpecifiers(source: string): string[] {
  const code = stripJsComments(source);
  const found = new Set<string>();
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[2]!;
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(spec)) { continue; }
      found.add(spec);
    }
  }
  return [...found];
}

/** `@a/b/c` -> `@a/b`, `a/b/c` -> `a`. */
export function packageNameOfSpecifier(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

const BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, '')));

function listDistScripts(dir: string): string[] {
  const dist = join(dir, 'dist');
  if (!existsSync(dist)) { return []; }
  return (readdirSync(dist, { recursive: true }) as string[])
    .filter(f => /\.(?:m|c)?js$/.test(f))
    .map(f => join('dist', f));
}

/** Packages the manifest lets the runtime import. devDependencies do not count: consumers never install them. */
function declaredRuntimeDeps(manifest: ManifestDeps): Set<string> {
  const declared = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  for (const bundled of [manifest.bundledDependencies, manifest.bundleDependencies]) {
    if (Array.isArray(bundled)) {
      for (const b of bundled) { if (typeof b === 'string') { declared.add(b); } }
    }
  }
  return declared;
}

/**
 * One message per (file, package) for imports in `dir/dist/**` of packages the
 * manifest does not declare. `allowlist` entries are an import name (`foo`,
 * `foo/sub`) or a `<package>:<import>` pair.
 */
export function findUndeclaredImports(dir: string, manifest: ManifestDeps, allowlist: string[] = []): string[] {
  const declared = declaredRuntimeDeps(manifest);
  const self = manifest.name ?? '';
  const allowed = new Set(allowlist);
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const file of listDistScripts(dir)) {
    let source: string;
    try { source = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    for (const spec of extractBareSpecifiers(source)) {
      const name = packageNameOfSpecifier(spec);
      if (name === self || BUILTINS.has(name) || BUILTINS.has(spec) || declared.has(name)) { continue; }
      if (allowed.has(name) || allowed.has(spec) || allowed.has(`${self}:${name}`)) { continue; }
      const key = `${file}\0${name}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      const dev = manifest.devDependencies && name in manifest.devDependencies
        ? ' (it is only in devDependencies, which consumers do not install)'
        : '';
      issues.push(
        `ERROR: undeclared dependency: ${self || 'package'} imports '${spec}' in ${file} but does not declare '${name}'${dev}\n` +
        '  hint: declare it in dependencies (or peerDependencies)',
      );
    }
  }
  return issues;
}
