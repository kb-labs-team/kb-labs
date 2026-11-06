#!/usr/bin/env node

/**
 * @kb-labs/devkit - CI Combo Tool
 *
 * Runs all devkit checks in one command for CI/CD pipelines.
 * Perfect for GitHub Actions, GitLab CI, or any CI/CD system.
 *
 * Checks performed:
 * 1. Naming convention validation
 * 2. Import issues (broken imports, unused deps, circular deps)
 * 3. Export issues (unused exports, dead code)
 * 4. Duplicate dependencies
 * 5. Package structure validation
 * 6. Path validation (workspace deps, exports, bin)
 * 7. TypeScript types (dts generation, types field)
 *
 * Usage:
 *   kb-devkit-ci                    # Run all checks
 *   kb-devkit-ci --skip naming      # Skip naming check
 *   kb-devkit-ci --only imports     # Run only imports check
 *   kb-devkit-ci --json             # Output JSON for parsing
 */

import { spawn } from 'node:child_process';
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
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Parse CLI arguments
const args = process.argv.slice(2);
const options = {
  skip: args.find((arg) => arg.startsWith('--skip='))?.split('=')[1]?.split(',') || [],
  only: args.find((arg) => arg.startsWith('--only='))?.split('=')[1]?.split(',') || [],
  json: args.includes('--json'),
  verbose: args.includes('--verbose') || args.includes('-v'),
};

/**
 * Available checks
 */
const CHECKS = {
  naming: {
    name: 'Naming Convention',
    command: 'devkit-validate-naming.mjs',
    emoji: '📦',
  },
  imports: {
    name: 'Import Analysis',
    command: 'devkit-check-imports.mjs',
    emoji: '🔍',
  },
  exports: {
    name: 'Export Analysis',
    command: 'devkit-check-exports.mjs',
    emoji: '📤',
  },
  duplicates: {
    name: 'Duplicate Dependencies',
    command: 'devkit-check-duplicates.mjs',
    emoji: '🔄',
  },
  structure: {
    name: 'Package Structure',
    command: 'devkit-check-structure.mjs',
    emoji: '📐',
  },
  paths: {
    name: 'Path Validation',
    command: 'devkit-check-paths.mjs',
    emoji: '🔗',
  },
  types: {
    name: 'TypeScript Types',
    command: 'devkit-check-types.mjs',
    emoji: '📝',
  },

};

/**
 * Run a single check
 */
function runCheck(checkId, check) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const scriptPath = path.join(__dirname, check.command);

    if (!options.json) {
      log(`\n${check.emoji} Running ${check.name}...`, 'blue');
    }

    const child = spawn('node', [scriptPath], {
      stdio: options.json ? 'pipe' : 'inherit',
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    if (options.json) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      resolve({
        checkId,
        name: check.name,
        emoji: check.emoji,
        passed: code === 0,
        exitCode: code,
        duration: parseFloat(duration),
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      resolve({
        checkId,
        name: check.name,
        emoji: check.emoji,
        passed: false,
        exitCode: 1,
        duration: 0,
        error: err.message,
      });
    });
  });
}

/**
 * Main function
 */
async function main() {
  const startTime = Date.now();

  if (!options.json) {
    log('\n🚀 KB Labs CI Checker\n', 'bold');
    log('Running all devkit checks...\n', 'gray');
  }

  // Determine which checks to run
  let checksToRun = Object.keys(CHECKS);

  if (options.only.length > 0) {
    checksToRun = checksToRun.filter((id) => options.only.includes(id));
  }

  if (options.skip.length > 0) {
    checksToRun = checksToRun.filter((id) => !options.skip.includes(id));
  }

  if (checksToRun.length === 0) {
    log('⚠️  No checks to run', 'yellow');
    process.exit(0);
  }

  // Run all checks
  const results = [];

  for (const checkId of checksToRun) {
    const check = CHECKS[checkId];
    const result = await runCheck(checkId, check);
    results.push(result);

    if (!options.json) {
      if (result.passed) {
        log(`   ✅ ${result.name} passed (${result.duration}s)`, 'green');
      } else {
        log(`   ❌ ${result.name} failed (${result.duration}s)`, 'red');
      }
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  // Print summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  if (options.json) {
    // JSON output for CI parsing
    const output = {
      summary: {
        total,
        passed,
        failed,
        duration: parseFloat(totalDuration),
        success: failed === 0,
      },
      checks: results.map((r) => ({
        id: r.checkId,
        name: r.name,
        passed: r.passed,
        exitCode: r.exitCode,
        duration: r.duration,
        error: r.error,
      })),
    };

    console.log(JSON.stringify(output, null, 2));
  } else {
    log('\n' + '─'.repeat(60) + '\n', 'gray');
    log('📊 Summary:\n', 'blue');

    log(`   Total checks:  ${total}`, 'cyan');
    log(`   ✅ Passed:     ${passed}`, 'green');
    if (failed > 0) {
      log(`   ❌ Failed:     ${failed}`, 'red');
    }
    log(`   ⏱️  Duration:   ${totalDuration}s`, 'gray');

    log('', 'reset');

    if (failed > 0) {
      log('💡 Failed checks:', 'yellow');
      for (const result of results.filter((r) => !r.passed)) {
        log(`   • ${result.name}`, 'red');
      }
      log('', 'reset');
    }

    log('💡 Tips:', 'blue');
    log('   • Run individual checks to see detailed output', 'gray');
    log('   • Use --skip=<check> to skip specific checks', 'gray');
    log('   • Use --only=<check> to run only specific checks', 'gray');
    log('   • Use --json for machine-readable output', 'gray');
    log('', 'reset');
  }

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

main();
