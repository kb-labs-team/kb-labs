# KB Labs DevKit - Usage Guide & Real-World Use Cases

Complete guide to using all devkit tools for maintaining a healthy monorepo with 100+ packages.

---

## 📚 Table of Contents

- [Quick Start](#quick-start)
- [Daily Workflow](#daily-workflow)
- [CI/CD Integration](#cicd-integration)
- [Maintenance Tasks](#maintenance-tasks)
- [Troubleshooting](#troubleshooting)
- [Tool Reference](#tool-reference)
- [Real-World Use Cases](#real-world-use-cases)

---

## 🚀 Quick Start

### Initial Setup

```bash
# Clone monorepo
cd /path/to/kb-labs

# Run full health check
npx kb-devkit-ci

# View statistics
npx kb-devkit-stats --health

# Visualize dependencies
npx kb-devkit-visualize --stats
```

### First Cleanup

```bash
# 1. Fix naming violations
npx kb-devkit-validate-naming

# 2. Remove unused dependencies (dry-run first!)
npx kb-devkit-fix-deps --remove-unused --dry-run
npx kb-devkit-fix-deps --remove-unused

# 3. Align duplicate versions
npx kb-devkit-fix-deps --align-versions

# 4. Run pnpm install
pnpm install
```

---

## 🔄 Daily Workflow

### Before Starting Work

```bash
# Quick status check
npx kb-devkit-stats

# Check specific package you'll work on
npx kb-devkit-visualize --package=cli-core --tree
```

### After Making Changes

```bash
# Validate changes
npx kb-devkit-check-imports --package your-package
npx kb-devkit-check-structure --package your-package

# Check naming if you added new package
npx kb-devkit-validate-naming
```

### Before Committing

```bash
# Run all checks
npx kb-devkit-ci

# Or just essentials
npx kb-devkit-ci --only=naming,imports
```

---

## 🤖 CI/CD Integration

### GitHub Actions

**.github/workflows/devkit-check.yml**:
```yaml
name: DevKit Checks

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  devkit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 9

      - name: Install dependencies
        run: pnpm install

      - name: Run DevKit CI
        run: npx kb-devkit-ci --json > devkit-report.json

      - name: Upload Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: devkit-report
          path: devkit-report.json

      - name: Comment PR
        if: failure() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('devkit-report.json'));
            const failedChecks = report.checks.filter(c => !c.passed);

            const comment = `## 🚨 DevKit Checks Failed\n\n` +
              failedChecks.map(c => `- ❌ ${c.name}`).join('\n');

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: comment
            });
```

### Pre-commit Hook

**.husky/pre-commit**:
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run quick checks
npx kb-devkit-ci --only=naming,imports --json
```

### Package.json Scripts

```json
{
  "scripts": {
    "check": "kb-devkit-ci",
    "check:quick": "kb-devkit-ci --skip=exports,duplicates",
    "fix": "kb-devkit-fix-deps --all",
    "stats": "kb-devkit-stats --health",
    "prerelease": "kb-devkit-ci"
  }
}
```

---

## 🔧 Maintenance Tasks

### Weekly Cleanup

```bash
# Monday morning cleanup routine

# 1. View current health
npx kb-devkit-stats --health

# 2. Check for duplicates
npx kb-devkit-check-duplicates --verbose

# 3. Fix what's safe to fix
npx kb-devkit-fix-deps --remove-unused --dry-run
npx kb-devkit-fix-deps --remove-unused

# 4. Align versions
npx kb-devkit-fix-deps --align-versions

# 5. Run install
pnpm install

# 6. Verify everything still works
pnpm run build
pnpm run test
```

### Monthly Audit

```bash
# Full ecosystem audit

# 1. Generate report
npx kb-devkit-stats --json > stats-$(date +%Y-%m).json
npx kb-devkit-stats --md > STATS.md

# 2. Check all aspects
npx kb-devkit-ci --verbose

# 3. Review circular dependencies
npx kb-devkit-check-imports | grep "Circular"

# 4. Find largest packages
npx kb-devkit-visualize --stats | grep "Largest"

# 5. Check structure compliance
npx kb-devkit-check-structure --strict
```

### Before Major Release

```bash
# Pre-release checklist

# 1. Full validation
npx kb-devkit-ci

# 2. Check exports (public API)
npx kb-devkit-check-exports --strict

# 3. Verify no breaking changes in dependencies
npx kb-devkit-check-duplicates

# 4. Generate changelog stats
npx kb-devkit-stats --md >> CHANGELOG.md
```

---

## 🐛 Troubleshooting

### "Too many broken imports"

Many `.js` extension imports are expected (TypeScript ESM pattern). Focus on:

```bash
# Filter real issues
npx kb-devkit-check-imports | grep -v "\.js$"
```

### "Circular dependencies detected"

```bash
# See full cycles
npx kb-devkit-check-imports --verbose

# Visualize the problem
npx kb-devkit-visualize --package=problematic-package --tree
```

### "Version conflicts"

```bash
# See all duplicates
npx kb-devkit-check-duplicates --verbose

# Auto-fix (picks most common version)
npx kb-devkit-fix-deps --align-versions

# Manual fix for critical deps
# Edit package.json manually, then:
pnpm install
```

### "CI fails but local passes"

```bash
# Run exactly what CI runs
npx kb-devkit-ci --json

# Check specific tool
npx kb-devkit-check-structure --package your-package
```

---

## 📖 Tool Reference

### Core Tools

| Tool | Purpose | Speed | CI-Friendly |
|------|---------|-------|-------------|
| `kb-devkit-ci` | Run all checks | ⭐⭐ | ✅ Yes |
| `kb-devkit-stats` | Quick statistics | ⭐⭐⭐ | ✅ Yes |
| `kb-devkit-fix-deps` | Auto-fix dependencies | ⭐⭐ | ⚠️  Careful |

### Analysis Tools

| Tool | Purpose | Output | CI-Friendly |
|------|---------|--------|-------------|
| `kb-devkit-check-imports` | Find broken imports, unused deps | Detailed | ✅ Yes |
| `kb-devkit-check-exports` | Find dead code in APIs | Detailed | ✅ Yes |
| `kb-devkit-check-duplicates` | Find version conflicts | Summary | ✅ Yes |
| `kb-devkit-check-structure` | Validate package structure | Detailed | ✅ Yes |
| `kb-devkit-validate-naming` | Check naming convention | List | ✅ Yes |
| `kb-devkit-visualize` | Dependency graphs | Visual | ❌ No |

---

## 💡 Real-World Use Cases

### Use Case 1: Onboarding New Developer

**Scenario**: New developer joins, needs to understand codebase.

```bash
# Step 1: Show overview
npx kb-devkit-stats

# Output:
# 📦 Overview:
#    Packages:      90
#    Repositories:  15
#    Lines of Code: 226,514

# Step 2: Show dependency graph
npx kb-devkit-visualize --stats

# Output:
# Most Depended-On Packages:
#    1. @kb-labs/plugin-manifest (20 dependents)
#    2. @kb-labs/core-sys (19 dependents)

# Step 3: Explore specific area
npx kb-devkit-visualize --package=cli-core --tree

# Shows full dependency tree
```

### Use Case 2: Preparing for Release

**Scenario**: About to release v2.0, need to ensure quality.

```bash
# Week before release

# 1. Full health check
npx kb-devkit-ci
# ❌ Failed: 3 checks failed

# 2. Fix imports
npx kb-devkit-check-imports --verbose
# Found 212 unused dependencies

# 3. Auto-fix safe issues
npx kb-devkit-fix-deps --remove-unused
# ✅ Removed 212 unused dependency(ies)

# 4. Check public APIs
npx kb-devkit-check-exports --strict
# Found unused exports that can be removed

# 5. Final verification
npx kb-devkit-ci
# ✅ All 7 checks passed
```

### Use Case 3: Investigating Performance

**Scenario**: Build time increasing, need to find why.

```bash
# 1. Find largest packages
npx kb-devkit-visualize --stats

# Output:
# Largest Packages (by lines of code):
#   1. @kb-labs/mind-engine (15,234 lines)
#   2. @kb-labs/devlink/core (14,803 lines)

# 2. Check dependencies
npx kb-devkit-visualize --package=mind-engine

# Output:
#    Dependencies: 21 packages
#    (High coupling!)

# 3. Find duplicates (slower builds)
npx kb-devkit-check-duplicates

# Output:
#    tsup: 4 different versions
#    (Multiple versions slow down builds!)

# 4. Fix duplicates
npx kb-devkit-fix-deps --align-versions
# ✅ Aligned 90 dependency version(s)
```

### Use Case 4: Refactoring Project Structure

**Scenario**: Moving packages between repositories.

```bash
# Before moving packages

# 1. Document current state
npx kb-devkit-stats --json > before.json

# 2. Check dependencies of package to move
npx kb-devkit-visualize --package=old-location --tree

# 3. Identify dependents
npx kb-devkit-check-imports | grep "old-package"

# After moving

# 4. Validate naming
npx kb-devkit-validate-naming
# ❌ Package naming violation

# 5. Fix structure
npx kb-devkit-check-structure --package=new-location
# ✅ All checks passed

# 6. Verify no broken imports
npx kb-devkit-check-imports
# ✅ No broken imports

# 7. Compare stats
npx kb-devkit-stats --json > after.json
diff before.json after.json
```

### Use Case 5: CI/CD Optimization

**Scenario**: CI taking too long, optimize checks.

```bash
# Current CI (runs everything): ~5 minutes

# Optimize for PR checks (critical only)
npx kb-devkit-ci --only=naming,imports
# ⏱️ Duration: 1.2s

# Full check on main branch only
npx kb-devkit-ci
# ⏱️ Duration: 5.1s

# Weekly cron: deep analysis
npx kb-devkit-ci --verbose
npx kb-devkit-check-exports --strict
npx kb-devkit-check-duplicates --code
```

### Use Case 6: Debugging Circular Dependency

**Scenario**: Build fails due to circular dependency.

```bash
# 1. Find cycles
npx kb-devkit-check-imports

# Output:
# 🔄 Circular Dependencies (4):
# 1. @kb-labs/cli-commands → @kb-labs/cli-bin → @kb-labs/cli-commands

# 2. Visualize the problem
npx kb-devkit-visualize --package=cli-commands

# Output shows both directions:
#    Dependencies: cli-bin
#    Dependents: cli-bin (circular!)

# 3. Understand the relationship
npx kb-devkit-visualize --tree --package=cli-commands

# 4. Fix by extracting shared code
# Create: @kb-labs/cli-shared
# Move common code there
# Update imports

# 5. Verify fix
npx kb-devkit-check-imports
# ✅ No circular dependencies
```

### Use Case 7: Package Health Audit

**Scenario**: Monthly package quality review.

```bash
# 1. Generate health report
npx kb-devkit-stats --health

# Output:
# 💚 Health Score:
#    Score: 78/100 (Grade C)
#    Issues:
#    🔴 15 duplicate dependencies (-15)
#    🟡 8 packages missing README (-8)

# 2. Fix duplicates
npx kb-devkit-fix-deps --align-versions

# 3. Find packages without README
npx kb-devkit-check-structure --strict | grep "Missing.*README"

# 4. Check structure
npx kb-devkit-check-structure

# 5. Re-check health
npx kb-devkit-stats --health

# Output:
# 💚 Health Score:
#    Score: 93/100 (Grade A)
```

---

## 🎯 Best Practices

### DO ✅

- **Run `kb-devkit-ci` before every commit**
- **Use `--dry-run` before auto-fixing**
- **Check `--health` score weekly**
- **Fix issues incrementally** (don't try to fix everything at once)
- **Document stats** before/after major changes
- **Use `--json` output in CI** for parsing

### DON'T ❌

- **Don't skip `--dry-run` on `fix-deps`** (might break things!)
- **Don't ignore circular dependencies** (will cause runtime issues)
- **Don't run `--align-versions` without review** (might downgrade critical deps)
- **Don't disable checks in CI** (defeats the purpose)
- **Don't fix all unused deps blindly** (some are used indirectly)

---

## 📊 Metrics to Track

### Weekly

- Health score trend
- Number of packages
- Lines of code
- Duplicate dependencies count

### Monthly

- Largest packages (track growth)
- Most depended-on packages (API stability)
- Circular dependencies (should be 0)
- Structure compliance rate

### Per Release

- Total dependencies count
- External vs workspace deps ratio
- Unused dependencies removed
- API surface reduction (unused exports)

---

## 🔗 Quick Reference Card

```bash
# Quick checks
npx kb-devkit-stats              # Overview
npx kb-devkit-ci --only=imports  # Fast check

# Deep analysis
npx kb-devkit-check-imports --verbose    # All import issues
npx kb-devkit-check-exports --strict     # All export issues
npx kb-devkit-check-duplicates --code    # With code duplication

# Auto-fix
npx kb-devkit-fix-deps --remove-unused --dry-run   # Preview
npx kb-devkit-fix-deps --all --dry-run             # Preview all fixes
npx kb-devkit-fix-deps --all                       # Apply all

# CI/CD
npx kb-devkit-ci                 # All checks
npx kb-devkit-ci --json          # Machine-readable
npx kb-devkit-ci --skip=exports  # Skip specific checks

# Visualization
npx kb-devkit-visualize --stats              # Repository stats
npx kb-devkit-visualize --package=cli-core   # Specific package
npx kb-devkit-visualize --tree --package=x   # Dependency tree
```

---

## 💬 Support

- **Issues**: Found a bug? [Open an issue](https://github.com/kb-labs/kb-labs-devkit/issues)
- **Questions**: Ask in team chat or create a discussion
- **Contributions**: PRs welcome!

---

**Last Updated**: 2026-03-04
**Version**: 1.0.0
**Tools Count**: 29
