/**
 * @module @kb-labs/workflow-runtime/lint
 *
 * Pure file-discovery + validation utility behind `kb workflow lint`.
 *
 * Mirrors WorkspaceRegistry discovery (registry/workspace-registry.ts) and the
 * WorkflowLoader error format, but uses a non-throwing `safeParse` so it can
 * collect issues across every file instead of bailing on the first failure.
 */

import { readFile } from 'node:fs/promises'
import { statSync, readFileSync } from 'node:fs'
import { relative, resolve, basename } from 'node:path'

import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import { WorkflowSpecSchema, type FileLintResult } from '@kb-labs/workflow-contracts'

export interface LintOptions {
  /**
   * File or directory to lint. A directory is globbed; a single file is linted
   * directly. Defaults to `.kb/workflows` under `cwd`.
   */
  path?: string
  /** Working directory used to resolve `path`. Defaults to `process.cwd()`. */
  cwd?: string
  /** Glob patterns used when `path` is a directory. */
  patterns?: string[]
}

const DEFAULT_PATTERNS = ['**/*.yml', '**/*.yaml', '**/*.json']

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Lint workflow files against WorkflowSpecSchema.
 *
 * @returns one FileLintResult per discovered file (or the single targeted file).
 */
export async function lintWorkflowFiles(opts: LintOptions = {}): Promise<FileLintResult[]> {
  const cwd = opts.cwd ?? process.cwd()
  const target = resolve(cwd, opts.path ?? '.kb/workflows')

  // Single-file mode: lint exactly that file, attribute its path to the project root.
  if (isFile(target)) {
    return [await lintOne(target, cwd)]
  }

  const files = await fg(opts.patterns ?? DEFAULT_PATTERNS, {
    cwd: target,
    absolute: true,
    onlyFiles: true,
    ignore: ['node_modules/**', 'dist/**', '.git/**'],
  })

  const results = await Promise.all(files.map((file) => lintOne(file, cwd)))
  appendInvocationGraphDiagnostics(results)
  return results
}

/**
 * Verify `workflow:workspace:<file-stem>` references as one graph. Schema
 * validation can only inspect one document; this catches a missing reusable
 * component and indirect cycles before any run reaches a worker.
 */
function appendInvocationGraphDiagnostics(results: FileLintResult[]): void {
  const valid = results.filter((result) => result.ok)
  const byId = new Map(valid.map((result) => [basename(result.file).replace(/\.(ya?ml|json)$/i, ''), result]))
  const edges = new Map<string, string[]>()

  for (const result of valid) {
    const id = basename(result.file).replace(/\.(ya?ml|json)$/i, '')
    const parsed = parseDocument(result.file)
    const refs = parsed ? collectWorkspaceWorkflowRefs(parsed) : []
    edges.set(id, refs)
    for (const ref of refs) {
      if (!byId.has(ref)) {
        result.ok = false
        result.errors.push(`jobs: referenced workspace workflow "${ref}" was not found`)
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' -> ')
      const source = byId.get(path[path.length - 1] ?? id)
      if (source && !source.errors.some((error) => error.includes(`workflow invocation cycle: ${cycle}`))) {
        source.ok = false
        source.errors.push(`jobs: workflow invocation cycle: ${cycle}`)
      }
      return
    }
    if (visited.has(id)) {return}
    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (byId.has(next)) {visit(next, [...path, next])}
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) {visit(id, [id])}
}

function parseDocument(file: string): Record<string, unknown> | null {
  try {
    // lintOne has already verified parseability; sync parsing here keeps graph
    // analysis local and avoids changing the public lint result shape.
    const raw = readFileSync(file, 'utf-8')
    return (file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}

function collectWorkspaceWorkflowRefs(document: Record<string, unknown>): string[] {
  const jobs = document['jobs']
  if (!jobs || typeof jobs !== 'object') {return []}
  const refs: string[] = []
  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== 'object') {continue}
    const steps = (job as Record<string, unknown>)['steps']
    if (!Array.isArray(steps)) {continue}
    for (const step of steps) {
      const uses = step && typeof step === 'object' ? (step as Record<string, unknown>)['uses'] : undefined
      if (typeof uses === 'string' && uses.startsWith('workflow:workspace:')) {
        refs.push(uses.slice('workflow:workspace:'.length))
      }
    }
  }
  return refs
}

async function lintOne(file: string, base: string): Promise<FileLintResult> {
  const relativePath = relative(base, file) || basename(file)
  try {
    const raw = await readFile(file, 'utf-8')
    const parsed = file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)
    const result = WorkflowSpecSchema.safeParse(parsed)
    if (result.success) {
      return { file, relativePath, ok: true, errors: [], warnings: [] }
    }
    return {
      file,
      relativePath,
      ok: false,
      errors: result.error.issues.map(formatIssue),
      warnings: [],
    }
  } catch (err) {
    // Parse/IO failure (malformed YAML/JSON, unreadable file).
    return {
      file,
      relativePath,
      ok: false,
      errors: [`(root): ${(err as Error).message}`],
      warnings: [],
    }
  }
}

/**
 * Format a ZodIssue as `<json-path>: <message>`. Refine-level issues carry an
 * empty path, so fall back to `(root)` — matching the WorkflowLoader format.
 */
function formatIssue(issue: { path: (string | number)[]; message: string }): string {
  const path = issue.path.join('.') || '(root)'
  return `${path}: ${issue.message}`
}
