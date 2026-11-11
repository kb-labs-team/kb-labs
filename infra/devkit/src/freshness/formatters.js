/**
 * Output formatters: Table, JSON, Markdown, Tree
 */

import { topologicalSort } from './graph.js';

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
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Format age in human-readable format
 */
function formatAge(distMtime) {
  if (!distMtime) {return '-';}

  const now = Date.now();
  const ageMs = now - distMtime;

  const minutes = Math.floor(ageMs / (1000 * 60));
  const hours = Math.floor(ageMs / (1000 * 60 * 60));
  const days = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  // Less than 1 hour - show minutes
  if (hours === 0) {
    if (minutes === 0) {return '<1m';}
    if (minutes === 1) {return '1m';}
    return `${minutes}m`;
  }

  // Less than 24 hours - show hours
  if (days === 0) {
    if (hours === 1) {return '1h';}
    return `${hours}h`;
  }

  // 1 day or more - show days
  if (days === 1) {return '1d';}
  return `${days}d`;
}

/**
 * Get status icon
 */
function getStatusIcon(status) {
  switch (status) {
    case 'fresh':
      return '✅';
    case 'stale':
      return '⚠️';
    case 'never-built':
      return '❌';
    default:
      return '?';
  }
}

/**
 * Get primary issue message
 */
function getPrimaryIssue(result) {
  if (result.issues.length === 0) {return '-';}

  // Prioritize errors, then warnings, then info
  const error = result.issues.find((i) => i.severity === 'error');
  if (error) {return error.message;}

  const warning = result.issues.find((i) => i.severity === 'warning');
  if (warning) {return warning.message;}

  return result.issues[0].message;
}

/**
 * Filter results based on options
 */
function filterResults(freshnessResults, options) {
  let filtered = Array.from(freshnessResults.values());

  // Filter by stale only
  if (options.onlyStale) {
    filtered = filtered.filter((r) => r.status === 'stale' || r.status === 'never-built');
  }

  // Filter by high impact
  if (options.highImpact) {
    filtered = filtered.filter((r) => r.impactScore >= options.highImpact);
  }

  return filtered;
}

/**
 * Get high impact packages
 */
function getHighImpact(freshnessResults, threshold = 5) {
  return Array.from(freshnessResults.values())
    .filter((r) => r.impactScore >= threshold && r.status !== 'fresh')
    .sort((a, b) => b.impactScore - a.impactScore)
    .map((r) => ({
      name: r.pkgName,
      affectedCount: r.impactScore,
      reason: r.issues.find((i) => i.severity === 'error')?.message || 'Unknown',
    }));
}

/**
 * Print table format
 */
export function printTable(freshnessResults, graph, options) {
  const filtered = filterResults(freshnessResults, options);

  // Statistics
  const total = freshnessResults.size;
  const fresh = Array.from(freshnessResults.values()).filter((r) => r.status === 'fresh').length;
  const stale = Array.from(freshnessResults.values()).filter((r) => r.status === 'stale').length;
  const neverBuilt = Array.from(freshnessResults.values()).filter((r) => r.status === 'never-built').length;

  log('\n📦 Package Build Freshness Report\n', 'bold');

  log('Legend:', 'blue');
  log('  ✅ Fresh    - Built with latest sources and dependencies', 'green');
  log('  ⚠️  Stale   - Needs rebuild (version/time/dependency mismatch)', 'yellow');
  log('  ❌ Never    - Never built', 'red');
  log('  📊 Impact   - Number of packages affected if stale\n', 'gray');

  // Table header
  const nameWidth = 35;
  const statusWidth = 10;
  const impactWidth = 8;
  const issueWidth = 40;
  const ageWidth = 6;

  const separator = '─'.repeat(nameWidth + statusWidth + impactWidth + issueWidth + ageWidth + 10);

  log(separator, 'gray');
  log(
    `${'Package'.padEnd(nameWidth)} │ ${'Status'.padEnd(statusWidth)} │ ${'Impact'.padEnd(impactWidth)} │ ${'Issues'.padEnd(issueWidth)} │ ${'Age'.padEnd(ageWidth)}`,
    'cyan'
  );
  log(separator, 'gray');

  // Sort by impact score (desc), then by status
  const sorted = filtered.sort((a, b) => {
    if (a.impactScore !== b.impactScore) {
      return b.impactScore - a.impactScore;
    }
    if (a.status !== b.status) {
      const statusOrder = { 'stale': 0, 'never-built': 1, 'fresh': 2 };
      return statusOrder[a.status] - statusOrder[b.status];
    }
    return a.pkgName.localeCompare(b.pkgName);
  });

  for (const result of sorted) {
    const statusIcon = getStatusIcon(result.status);
    const statusText = `${statusIcon} ${result.status.padEnd(7)}`;
    const impactText = result.impactScore.toString().padStart(4);
    const issue = getPrimaryIssue(result).substring(0, issueWidth);
    const age = formatAge(result.meta.distMtime);

    const color = result.status === 'fresh' ? 'green' : result.status === 'stale' ? 'yellow' : 'red';

    log(
      `${result.pkgName.padEnd(nameWidth)} │ ${statusText.padEnd(statusWidth)} │ ${impactText.padEnd(impactWidth)} │ ${issue.padEnd(issueWidth)} │ ${age.padEnd(ageWidth)}`,
      color
    );
  }

  log(separator, 'gray');

  // Summary
  log('\n📊 Summary:', 'blue');
  log(`   Total packages:     ${total}`, 'cyan');
  log(`   ✅ Fresh:           ${fresh} (${((fresh / total) * 100).toFixed(0)}%)`, 'green');
  log(`   ⚠️  Stale:          ${stale} (${((stale / total) * 100).toFixed(0)}%)`, 'yellow');
  log(`   ❌ Never built:     ${neverBuilt} (${((neverBuilt / total) * 100).toFixed(0)}%)\n`, 'red');

  // High impact packages
  const highImpact = getHighImpact(freshnessResults, options.highImpact || 5);
  if (highImpact.length > 0) {
    log('🔥 High Impact (affects 5+ packages):', 'blue');
    for (let i = 0; i < Math.min(highImpact.length, 10); i++) {
      const pkg = highImpact[i];
      log(`   ${i + 1}. ${pkg.name} (${pkg.affectedCount} affected)`, 'yellow');
      log(`      ${pkg.reason}`, 'gray');
    }
    log('');
  }

  // Rebuild order suggestion
  if (options.suggestRebuild || stale > 0) {
    const stalePackages = Array.from(freshnessResults.values())
      .filter((r) => r.status === 'stale')
      .map((r) => r.pkgName);

    if (stalePackages.length > 0) {
      const rebuildOrder = topologicalSort(stalePackages, graph);

      log('💡 Suggested rebuild order:', 'blue');
      for (let i = 0; i < Math.min(rebuildOrder.length, 10); i++) {
        log(`   ${i + 1}. ${rebuildOrder[i]}`, 'cyan');
      }
      if (rebuildOrder.length > 10) {
        log(`   ... and ${rebuildOrder.length - 10} more`, 'gray');
      }
      log('');
    }
  }
}

/**
 * Print JSON format (AI-optimized)
 */
export function printJSON(freshnessResults, graph, options) {
  const total = freshnessResults.size;
  const fresh = Array.from(freshnessResults.values()).filter((r) => r.status === 'fresh').length;
  const stale = Array.from(freshnessResults.values()).filter((r) => r.status === 'stale').length;
  const neverBuilt = Array.from(freshnessResults.values()).filter((r) => r.status === 'never-built').length;

  const stalePackages = Array.from(freshnessResults.values())
    .filter((r) => r.status === 'stale')
    .map((r) => r.pkgName);

  const rebuildOrder = stalePackages.length > 0 ? topologicalSort(stalePackages, graph) : [];

  const highImpact = getHighImpact(freshnessResults, options.highImpact || 5);

  const output = {
    metadata: {
      timestamp: new Date().toISOString(),
      totalPackages: total,
      fresh,
      stale,
      neverBuilt,
      rootDir: process.cwd(),
    },
    packages: Array.from(freshnessResults.values()).map((result) => {
      const node = graph.get(result.pkgName);
      const dependencies = node ? Array.from(node.dependencies.keys()) : [];
      const dependents = node ? Array.from(node.dependents) : [];

      return {
        name: result.pkgName,
        status: result.status,
        impactScore: result.impactScore,
        version: {
          current: result.meta.version,
          built: result.meta.builtVersion,
        },
        timestamps: {
          srcMtime: result.meta.srcMtime,
          distMtime: result.meta.distMtime,
          ageDays: result.meta.distMtime
            ? (Date.now() - result.meta.distMtime) / (1000 * 60 * 60 * 24)
            : null,
        },
        issues: result.issues,
        dependencies: {
          workspace: dependencies,
          stale: dependencies.filter((dep) => {
            const depResult = freshnessResults.get(dep);
            return depResult && depResult.status !== 'fresh';
          }),
        },
        dependents,
      };
    }),
    rebuildOrder,
    highImpact,
  };

  console.log(JSON.stringify(output, null, 2));
}

/**
 * Print Markdown format
 */
export function printMarkdown(freshnessResults, graph) {
  const total = freshnessResults.size;
  const fresh = Array.from(freshnessResults.values()).filter((r) => r.status === 'fresh').length;
  const stale = Array.from(freshnessResults.values()).filter((r) => r.status === 'stale').length;
  const neverBuilt = Array.from(freshnessResults.values()).filter((r) => r.status === 'never-built').length;

  console.log('# Package Build Freshness Report\n');
  console.log(`**Generated:** ${new Date().toISOString()}`);
  console.log(`**Root:** ${process.cwd()}\n`);

  console.log('## Summary\n');
  console.log('| Metric | Count | Percentage |');
  console.log('|--------|-------|------------|');
  console.log(`| **Total packages** | ${total} | 100% |`);
  console.log(`| ✅ Fresh | ${fresh} | ${((fresh / total) * 100).toFixed(0)}% |`);
  console.log(`| ⚠️ Stale | ${stale} | ${((stale / total) * 100).toFixed(0)}% |`);
  console.log(`| ❌ Never built | ${neverBuilt} | ${((neverBuilt / total) * 100).toFixed(0)}% |\n`);

  const highImpact = getHighImpact(freshnessResults, 5);
  if (highImpact.length > 0) {
    console.log('## High Impact Issues\n');
    console.log('Packages that affect 5+ other packages:\n');

    for (let i = 0; i < highImpact.length; i++) {
      const pkg = highImpact[i];
      const result = Array.from(freshnessResults.values()).find((r) => r.pkgName === pkg.name);
      const age = formatAge(result?.meta.distMtime);

      console.log(`${i + 1}. **${pkg.name}** (${pkg.affectedCount} affected)`);
      console.log(`   - ${getStatusIcon(result.status)} ${pkg.reason}`);
      console.log(`   - Last built: ${age}\n`);
    }
  }

  const staleResults = Array.from(freshnessResults.values()).filter((r) => r.status === 'stale');
  if (staleResults.length > 0) {
    console.log('## Stale Packages\n');
    console.log('| Package | Issues | Impact | Age |');
    console.log('|---------|--------|--------|-----|');

    for (const result of staleResults) {
      const issue = getPrimaryIssue(result);
      const age = formatAge(result.meta.distMtime);
      console.log(`| ${result.pkgName} | ${issue} | ${result.impactScore} | ${age} |`);
    }
    console.log('');
  }

  const stalePackages = staleResults.map((r) => r.pkgName);
  if (stalePackages.length > 0) {
    const rebuildOrder = topologicalSort(stalePackages, graph);

    console.log('## Suggested Rebuild Order\n');
    console.log('```bash');
    for (const pkg of rebuildOrder) {
      console.log(`pnpm --filter ${pkg} run build`);
    }
    console.log('```\n');
  }
}

/**
 * Print Tree format
 */
export function printTree(freshnessResults, graph, options) {
  log('\n📦 Dependency Staleness Tree\n', 'blue');

  // If package filter specified, show that package's tree
  if (options.package) {
    const packages = Array.from(freshnessResults.keys());
    const fullPackageName = packages.find((p) => p.includes(options.package));

    if (!fullPackageName) {
      log(`   Package "${options.package}" not found\n`, 'red');
      return;
    }

    printPackageTree(fullPackageName, graph, freshnessResults, 0, new Set());
  } else {
    // Show trees for all root packages (packages with no dependents)
    const roots = Array.from(freshnessResults.values())
      .filter((r) => {
        const node = graph.get(r.pkgName);
        return node && node.dependents.size === 0;
      })
      .slice(0, 10); // Limit to first 10

    for (const root of roots) {
      printPackageTree(root.pkgName, graph, freshnessResults, 0, new Set());
      log('');
    }

    if (roots.length === 0) {
      log('   No root packages found (all packages have dependents)\n', 'gray');
    }
  }

  log('Legend:', 'blue');
  log('  ✅ Fresh', 'green');
  log('  ⚠️  Transitively stale (depends on stale package)', 'yellow');
  log('  ❌ Directly stale (version/time/dependency issue)\n', 'red');
}

function printPackageTree(pkgName, graph, results, depth, visited) {
  if (visited.has(pkgName)) {
    const indent = '  '.repeat(depth);
    log(`${indent}└─ ${pkgName} ${colors.gray}(circular)${colors.reset}`, 'yellow');
    return;
  }

  visited.add(pkgName);

  const result = results.get(pkgName);
  const node = graph.get(pkgName);

  if (!result || !node) {
    visited.delete(pkgName);
    return;
  }

  const statusIcon = getStatusIcon(result.status);
  const indent = '  '.repeat(depth);
  const issues = result.issues.filter((i) => i.severity === 'error');
  const issueText = issues.length > 0 ? ` [${issues[0].message}]` : '';

  const color = result.status === 'fresh' ? 'green' : result.status === 'stale' ? 'yellow' : 'red';

  log(`${indent}${depth > 0 ? '└─ ' : ''}${pkgName} ${statusIcon}${issueText}`, color);

  // Show dependencies
  const deps = Array.from(node.dependencies.keys());
  for (let i = 0; i < deps.length; i++) {
    printPackageTree(deps[i], graph, results, depth + 1, new Set(visited));
  }

  visited.delete(pkgName);
}
