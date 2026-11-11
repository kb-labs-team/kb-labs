#!/usr/bin/env node

/**
 * @kb-labs/devkit - Package Build Freshness Tracker
 *
 * Detects stale packages in monorepo dependency chains.
 * Critical: identifies when package A uses old version of dependency B,
 * even though B has been rebuilt with newer version.
 *
 * Usage:
 *   npx kb-devkit-freshness                      # Default table output
 *   npx kb-devkit-freshness --json               # JSON for AI agents
 *   npx kb-devkit-freshness --md                 # Markdown for docs
 *   npx kb-devkit-freshness --tree               # Dependency tree view
 *   npx kb-devkit-freshness --package=cli-core   # Single package analysis
 *   npx kb-devkit-freshness --only-stale         # Show only stale packages
 *   npx kb-devkit-freshness --age-days=30        # Packages not built in 30+ days
 *   npx kb-devkit-freshness --high-impact=5      # Packages affecting 5+ others
 *   npx kb-devkit-freshness --suggest-rebuild    # Show rebuild order
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function log(message, color = 'reset') {
  if (!options.json) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const options = {
  package: args.find((arg) => arg.startsWith('--package='))?.split('=')[1],
  json: args.includes('--json'),
  md: args.includes('--md'),
  tree: args.includes('--tree'),
  onlyStale: args.includes('--only-stale'),
  suggestRebuild: args.includes('--suggest-rebuild'),
  ageDays: parseInt(args.find((arg) => arg.startsWith('--age-days='))?.split('=')[1]) || null,
  highImpact: parseInt(args.find((arg) => arg.startsWith('--high-impact='))?.split('=')[1]) || null,
  help: args.includes('--help') || args.includes('-h'),
};

/**
 * Show help text
 */
function showHelp() {
  console.log(`
📦 KB Labs Package Build Freshness Tracker

Detects stale packages in monorepo dependency chains.

USAGE:
  npx kb-devkit-freshness [options]

OPTIONS:
  --json                  Output JSON format (AI-optimized)
  --md                    Output Markdown format
  --tree                  Show dependency tree view
  --package=<name>        Analyze single package
  --only-stale            Show only stale packages
  --age-days=<N>          Show packages not built in N+ days
  --high-impact=<N>       Show packages affecting N+ others
  --suggest-rebuild       Show suggested rebuild order
  -h, --help              Show this help

EXAMPLES:
  # Default table output
  npx kb-devkit-freshness

  # JSON for AI agents
  npx kb-devkit-freshness --json

  # Single package analysis with tree view
  npx kb-devkit-freshness --package=cli-core --tree

  # Find high-impact stale packages
  npx kb-devkit-freshness --only-stale --high-impact=5

  # Packages not built in 30+ days
  npx kb-devkit-freshness --age-days=30 --suggest-rebuild

STALENESS CRITERIA:
  1. Version Mismatch - Built version != current version
  2. Time-based - Source files newer than dist files
  3. Dependency Staleness - Dependency rebuilt after this package (CRITICAL!)

For more info: https://github.com/kb-labs/kb-labs
`);
}

/**
 * Main function
 */
async function main() {
  if (options.help) {
    showHelp();
    process.exit(0);
  }

  const rootDir = process.cwd();

  if (!options.json && !options.md) {
    log('\n🔍 KB Labs Package Build Freshness Tracker\n', 'blue');
    if (options.package) {
      log(`Analyzing package: ${options.package}\n`, 'gray');
    } else {
      log('Analyzing all packages...\n', 'gray');
    }
  }

  try {
    // Phase 1: Find packages
    const { findPackages } = await import('../src/freshness/metadata.js');
    const packages = findPackages(rootDir, options.package);

    if (packages.length === 0) {
      log('⚠️  No KB Labs packages found', 'yellow');
      log('   Run this command from the monorepo root\n', 'gray');
      process.exit(0);
    }

    if (!options.json && !options.md) {
      log(`Found ${packages.length} package(s) to analyze\n`, 'gray');
    }

    // Phase 2: Collect metadata
    const { collectAllMetadata } = await import('../src/freshness/metadata.js');
    const metadata = await collectAllMetadata(packages);

    // Phase 3: Build dependency graph
    const { buildDependencyGraph } = await import('../src/freshness/graph.js');
    const graph = buildDependencyGraph(metadata);

    // Phase 4: Analyze staleness
    const { analyzeStaleness } = await import('../src/freshness/analyzer.js');
    const freshnessResults = new Map();

    for (const pkg of packages) {
      const packageJson = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
      const packageName = packageJson.name;
      const meta = metadata.get(packageName);

      if (meta) {
        const result = analyzeStaleness(packageName, meta, graph, options);
        freshnessResults.set(packageName, result);
      }
    }

    // Phase 5: Propagate staleness and calculate impact
    const { propagateStaleness } = await import('../src/freshness/propagate.js');
    propagateStaleness(freshnessResults, graph);

    // Phase 6: Format output
    const formatters = await import('../src/freshness/formatters.js');

    if (options.json) {
      formatters.printJSON(freshnessResults, graph, options);
    } else if (options.md) {
      formatters.printMarkdown(freshnessResults, graph);
    } else if (options.tree) {
      formatters.printTree(freshnessResults, graph, options);
    } else {
      formatters.printTable(freshnessResults, graph, options);
    }

    // Exit code: 1 if stale packages found, 0 otherwise
    const staleCount = Array.from(freshnessResults.values()).filter(
      (r) => r.status === 'stale'
    ).length;

    process.exit(staleCount > 0 ? 1 : 0);
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(2);
  }
}

main();
