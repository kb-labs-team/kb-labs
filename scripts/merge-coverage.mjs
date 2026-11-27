#!/usr/bin/env node
// Aggregates per-package coverage-final.json and checks thresholds from devkit.yaml.
//
// Usage:
//   node scripts/merge-coverage.mjs           # aggregate + check + human output
//   node scripts/merge-coverage.mjs --check   # check existing summary only (no re-aggregate)
//   node scripts/merge-coverage.mjs --json    # aggregate + check + JSON output

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { load as parseYaml } from 'js-yaml'
import { checkCoverageFloor, countAcceptedThresholdViolations, findNewThresholdViolations } from './ci/coverage-floor.mjs'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CHECK_ONLY = process.argv.includes('--check')
const JSON_MODE = process.argv.includes('--json')
const OUT_DIR = join(ROOT, 'coverage')
const SUMMARY = join(OUT_DIR, 'summary.json')
const FLOOR_PATH = join(ROOT, 'scripts/ci/coverage-floor.json')

// ── Load thresholds from devkit.yaml ────────────────────────────────────────

function loadCoverageConfig() {
  const yaml = parseYaml(readFileSync(join(ROOT, 'devkit.yaml'), 'utf8'))
  return yaml.coverage ?? { categories: {}, thresholds: {} }
}

function matchCategory(packageName, categoryMap) {
  for (const [pattern, category] of Object.entries(categoryMap)) {
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    if (re.test(packageName)) return category
  }
  return null
}

function getThreshold(packageName, config) {
  const category = matchCategory(packageName, config.categories)
  if (!category || config.thresholds[category] === null) return null
  return config.thresholds[category] ?? null
}

// ── Walk workspace for coverage-final.json ──────────────────────────────────

function* walkCoverage(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'coverage') yield full
      else yield* walkCoverage(full)
    }
  }
}

function readPackageName(covDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(covDir), 'package.json'), 'utf8'))
    return pkg.name ?? dirname(covDir).replace(ROOT, '').replace(/^\//, '')
  } catch {
    return dirname(covDir).replace(ROOT, '').replace(/^\//, '')
  }
}

function parseCoverageFinal(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  let stmts = 0, stmtsHit = 0, branches = 0, branchesHit = 0, fns = 0, fnsHit = 0
  for (const fc of Object.values(data)) {
    const s = fc.s ?? {}
    stmts += Object.keys(s).length
    stmtsHit += Object.values(s).filter(v => v > 0).length
    for (const b of Object.values(fc.b ?? {})) {
      branches += b.length
      branchesHit += b.filter(v => v > 0).length
    }
    const f = fc.f ?? {}
    fns += Object.keys(f).length
    fnsHit += Object.values(f).filter(v => v > 0).length
  }
  return { stmts, stmtsHit, branches, branchesHit, fns, fnsHit }
}

// ── Aggregate ────────────────────────────────────────────────────────────────

function aggregate() {
  const packages = []
  let totals = { stmts: 0, stmtsHit: 0, branches: 0, branchesHit: 0, fns: 0, fnsHit: 0 }

  for (const covDir of walkCoverage(ROOT)) {
    const finalPath = join(covDir, 'coverage-final.json')
    try { statSync(finalPath) } catch { continue }

    const name = readPackageName(covDir)
    try {
      const c = parseCoverageFinal(finalPath)
      packages.push({
        package: name,
        statements: { hit: c.stmtsHit, total: c.stmts, pct: c.stmts ? +(c.stmtsHit / c.stmts * 100).toFixed(1) : 0 },
        branches:   { hit: c.branchesHit, total: c.branches, pct: c.branches ? +(c.branchesHit / c.branches * 100).toFixed(1) : 0 },
        functions:  { hit: c.fnsHit, total: c.fns, pct: c.fns ? +(c.fnsHit / c.fns * 100).toFixed(1) : 0 },
      })
      for (const k of ['stmts', 'stmtsHit', 'branches', 'branchesHit', 'fns', 'fnsHit'])
        totals[k] += c[k]
    } catch (e) {
      if (!JSON_MODE) process.stderr.write(`  warn: ${name}: ${e.message}\n`)
    }
  }

  packages.sort((a, b) => a.statements.pct - b.statements.pct)

  const result = {
    ok: true,
    total: {
      packages: packages.length,
      statements: { hit: totals.stmtsHit, total: totals.stmts, pct: totals.stmts ? +(totals.stmtsHit / totals.stmts * 100).toFixed(1) : 0 },
      branches:   { hit: totals.branchesHit, total: totals.branches, pct: totals.branches ? +(totals.branchesHit / totals.branches * 100).toFixed(1) : 0 },
      functions:  { hit: totals.fnsHit, total: totals.fns, pct: totals.fns ? +(totals.fnsHit / totals.fns * 100).toFixed(1) : 0 },
    },
    worst: packages.slice(0, 20),
    packages,
  }

  return result
}

// ── Check thresholds ─────────────────────────────────────────────────────────

function checkThresholds(result, config) {
  const violations = []

  for (const pkg of result.packages) {
    const threshold = getThreshold(pkg.package, config)
    if (!threshold) continue

    for (const metric of ['statements', 'functions', 'branches']) {
      const limit = threshold[metric]
      if (limit == null) continue
      const actual = pkg[metric].pct
      if (actual < limit) {
        violations.push({ package: pkg.package, metric, actual, limit })
      }
    }
  }

  return violations
}

// ── Main ─────────────────────────────────────────────────────────────────────

const config = loadCoverageConfig()
const coverageFloor = JSON.parse(readFileSync(FLOOR_PATH, 'utf8'))

let result
if (CHECK_ONLY) {
  try {
    result = JSON.parse(readFileSync(SUMMARY, 'utf8'))
  } catch {
    process.stderr.write('No coverage data found. Run `pnpm coverage` first.\n')
    process.exit(1)
  }
} else {
  result = aggregate()
}

const violations = checkThresholds(result, config)
result.violations = violations
const floorViolations = checkCoverageFloor(result, coverageFloor)
const newThresholdViolations = findNewThresholdViolations(violations, coverageFloor)
const acceptedThresholdMissCount = countAcceptedThresholdViolations(violations, coverageFloor)
result.coverageFloor = {
  reference: coverageFloor.reference,
  acceptedMetricCount: Object.values(coverageFloor.metrics).reduce((count, metrics) => count + Object.keys(metrics).length, 0),
  acceptedThresholdMissCount,
  floorViolations,
  newThresholdViolations,
}
result.ok = floorViolations.length === 0 && newThresholdViolations.length === 0

if (!CHECK_ONLY) {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(SUMMARY, JSON.stringify(result, null, 2))
}

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

const t = result.total
console.log(`\nCoverage Summary (${t.packages} packages)`)
console.log(`  Statements: ${t.statements.pct}%  (${t.statements.hit}/${t.statements.total})`)
console.log(`  Branches:   ${t.branches.pct}%  (${t.branches.hit}/${t.branches.total})`)
console.log(`  Functions:  ${t.functions.pct}%  (${t.functions.hit}/${t.functions.total})`)

if (violations.length > 0) {
  console.log(`\nCoverage target shortfalls (${violations.length}; retained in the report):\n`)
  // Group by package for readability
  const byPkg = {}
  for (const v of violations) {
    if (!byPkg[v.package]) byPkg[v.package] = []
    byPkg[v.package].push(`${v.metric}: ${v.actual}% < ${v.limit}%`)
  }
  for (const [pkg, issues] of Object.entries(byPkg))
    console.log(`  ${pkg}\n    ${issues.join(', ')}`)
}

if (result.ok) {
  console.log(`\n✓ Coverage floor preserved (${result.coverageFloor.acceptedMetricCount} package metrics)`)
} else {
  console.log('\n✗ Coverage floor or new threshold failure:')
  for (const issue of newThresholdViolations) {
    console.log(`  ${issue.package} ${issue.metric}: ${issue.actual}% remains below target ${issue.limit}% and has no accepted floor`)
  }
  for (const issue of floorViolations) {
    if (issue.type === 'missing-package') console.log(`  ${issue.package}: package missing from coverage report`)
    else if (issue.type === 'missing-metric') console.log(`  ${issue.package} ${issue.metric}: baseline metric missing`)
    else console.log(`  ${issue.package} ${issue.metric}: ${issue.actual}% < accepted floor ${issue.minimum}%`)
  }
}

console.log(`\nJSON report: coverage/summary.json`)

process.exit(result.ok ? 0 : 1)
